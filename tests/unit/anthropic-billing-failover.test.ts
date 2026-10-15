import assert from "node:assert/strict";
import test from "node:test";

import { createChatPipelineHarness } from "../integration/_chatPipelineHarness.ts";

const harness = await createChatPipelineHarness("anthropic-billing-failover");
const { handleChat, buildRequest, buildClaudeResponse, seedConnection, seedApiKey, settingsDb } =
  harness;
const providers = await import("../../src/lib/db/providers.ts");
const affinity = await import("../../src/lib/db/sessionAccountAffinity.ts");
const { flushProxyLogsSync } = await import("../../src/lib/proxyLogger.ts");
const { __resetRateLimitManagerForTests } =
  await import("../../open-sse/services/rateLimitManager.ts");
const { setEmergencyFallbackFeatureFlagResolverForTest } =
  await import("../../open-sse/services/emergencyFallback.ts");
const billingMessage =
  "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.";
const billingResponse = () =>
  new Response(
    JSON.stringify({ error: { type: "invalid_request_error", message: billingMessage } }),
    {
      status: 400,
      headers: { "Content-Type": "application/json" },
    }
  );

test.beforeEach(async () => {
  flushProxyLogsSync();
  await harness.resetStorage();
  setEmergencyFallbackFeatureFlagResolverForTest(() => true);
  await settingsDb.updateSettings({
    memoryEnabled: false,
    skillsEnabled: false,
    semanticCacheEnabled: false,
    providerSessionAffinityTtlMs: { anthropic: 3_600_000 },
    fallbackStrategy: "fill-first",
    requestRetry: 3,
    maxRetryIntervalSec: 1,
  });
});

test.after(async () => {
  setEmergencyFallbackFeatureFlagResolverForTest(null);
  await __resetRateLimitManagerForTests();
  flushProxyLogsSync();
  await harness.cleanup();
});

async function seedPool() {
  const first = await seedConnection("anthropic", {
    name: "empty",
    apiKey: "test-empty",
    priority: 1,
  });
  const second = await seedConnection("anthropic", {
    name: "healthy",
    apiKey: "test-healthy",
    priority: 2,
  });
  // A configured emergency target must not replace the requested Sonnet before
  // the eligible Anthropic sibling has been tried.
  await seedConnection("nvidia", { apiKey: "test-emergency" });
  return { first, second };
}

function successStream() {
  const events = [
    {
      type: "message_start",
      message: {
        id: "msg_recovered",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-5-5",
        content: [],
        usage: { input_tokens: 5, output_tokens: 0 },
      },
    },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "recovered" } },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 2 },
    },
    { type: "message_stop" },
  ];
  return new Response(
    events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
    {
      headers: { "Content-Type": "text/event-stream" },
    }
  );
}

for (const stream of [false, true]) {
  for (const protocol of ["openai", "claude"]) {
    test(`${protocol} stream=${stream}: billing failure retries the sibling and moves session affinity`, async () => {
      const { first, second } = await seedPool();
      const session = `recovery-${protocol}-${stream}`;
      affinity.upsertSessionAccountAffinity(
        `header:${session}`,
        "anthropic",
        first.id,
        Date.now(),
        3_600_000
      );
      const calls: string[] = [];
      globalThis.fetch = async (input, init) => {
        assert.equal(
          new URL(String(input)).hostname,
          "api.anthropic.com",
          "same-provider accounts must precede emergency model fallback"
        );
        const key = new Headers(init?.headers).get("x-api-key") || "";
        calls.push(key);
        const sent = JSON.parse(String(init?.body));
        assert.equal(sent.model, "claude-sonnet-5-5");
        assert.equal(sent.output_config?.effort, "medium");
        assert.equal(sent.stream, stream);
        if (key === "test-empty") return billingResponse();
        assert.equal(key, "test-healthy");
        return stream ? successStream() : buildClaudeResponse("recovered", "claude-sonnet-5-5");
      };
      const body = {
        model:
          protocol === "claude"
            ? "anthropic/claude-sonnet-5-5"
            : "anthropic/claude-sonnet-5-5-medium",
        stream,
        max_tokens: 128,
        ...(protocol === "claude"
          ? { thinking: { type: "adaptive" }, output_config: { effort: "medium" } }
          : {}),
        messages: [{ role: "user", content: "hello" }],
      };
      const request = () =>
        buildRequest({
          url:
            protocol === "claude"
              ? "http://localhost/v1/messages"
              : "http://localhost/v1/chat/completions",
          body,
          headers: {
            "x-session-id": session,
            "x-omniroute-no-cache": "true",
            "x-omniroute-no-memory": "true",
          },
        });
      const response = await handleChat(request());
      assert.equal(response.status, 200);
      const wire = await response.text();
      assert.match(wire, /recovered/);
      assert.doesNotMatch(wire, /credit balance is too low/);
      assert.deepEqual(calls, ["test-empty", "test-healthy"]);
      assert.equal(
        affinity.getSessionAccountAffinity(`header:${session}`, "anthropic", 3_600_000)
          ?.connectionId,
        second.id
      );
      const again = await handleChat(request());
      assert.equal(again.status, 200);
      await again.text();
      assert.deepEqual(calls, ["test-empty", "test-healthy", "test-healthy"]);
      for (const connection of [first, second]) {
        const persisted = await providers.getProviderConnectionById(connection.id);
        assert.equal(persisted.isActive, true);
        assert.equal(persisted.testStatus, "active");
        assert.ok(!persisted.rateLimitedUntil);
      }
    });
  }
}

test("all accounts rejected: each eligible account is tried once and original billing failure is returned", async () => {
  await seedPool();
  await seedConnection("anthropic", { apiKey: "test-third", priority: 3 });
  const calls: string[] = [];
  globalThis.fetch = async (input, init) => {
    assert.equal(new URL(String(input)).hostname, "api.anthropic.com");
    calls.push(new Headers(init?.headers).get("x-api-key") || "");
    return billingResponse();
  };
  const response = await handleChat(
    buildRequest({
      body: {
        model: "anthropic/claude-sonnet-5-5-medium",
        stream: false,
        messages: [{ role: "user", content: "all accounts denied" }],
      },
    })
  );
  assert.equal(response.status, 400);
  assert.match(await response.text(), /credit balance is too low/);
  assert.equal(calls.length, 3);
  assert.equal(new Set(calls).size, 3);
});

test("API-key connection allowlist fences billing fallback to permitted accounts", async () => {
  const { first } = await seedPool();
  const key = await seedApiKey({ allowedConnections: [first.id] });
  const calls: string[] = [];
  globalThis.fetch = async (_input, init) => {
    calls.push(new Headers(init?.headers).get("x-api-key") || "");
    return billingResponse();
  };
  const response = await handleChat(
    buildRequest({
      authKey: key.key,
      body: {
        model: "anthropic/claude-sonnet-5-5-medium",
        stream: false,
        messages: [{ role: "user", content: "restricted CRM key" }],
      },
    })
  );
  assert.equal(response.status, 400);
  assert.match(await response.text(), /credit balance is too low/);
  assert.deepEqual(calls, ["test-empty"]);
});

test("an explicit operator connection pin does not silently rotate to siblings", async () => {
  const { first } = await seedPool();
  const calls: string[] = [];
  globalThis.fetch = async (_input, init) => {
    calls.push(new Headers(init?.headers).get("x-api-key") || "");
    return billingResponse();
  };
  const response = await handleChat(
    buildRequest({
      headers: { "x-omniroute-connection": first.id },
      body: {
        model: "anthropic/claude-sonnet-5-5-medium",
        stream: false,
        messages: [{ role: "user", content: "explicit operator pin" }],
      },
    })
  );
  assert.equal(response.status, 400);
  assert.deepEqual(calls, ["test-empty"]);
});

test("malformed-request 400 is returned without trying another account", async () => {
  await seedPool();
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response(
      JSON.stringify({
        error: { type: "invalid_request_error", message: "invalid messages content" },
      }),
      {
        status: 400,
        headers: { "Content-Type": "application/json" },
      }
    );
  };
  const response = await handleChat(
    buildRequest({
      body: {
        model: "anthropic/claude-sonnet-5-5-medium",
        stream: false,
        messages: [{ role: "user", content: "invalid request" }],
      },
    })
  );
  assert.equal(response.status, 400);
  assert.equal(calls, 1);
});
