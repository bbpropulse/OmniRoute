import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omni-anthropic-billing-"));
process.env.DATA_DIR = dataDir;
const core = await import("../../src/lib/db/core.ts");
const providers = await import("../../src/lib/db/providers.ts");
const { classifyProviderError } = await import("../../open-sse/services/errorClassifier.ts");
const { checkFallbackError, getModelLockoutInfo } =
  await import("../../open-sse/services/accountFallback.ts");
const { markAccountUnavailable, getProviderCredentials } =
  await import("../../src/sse/services/auth.ts");
const { handleChatCore } = await import("../../open-sse/handlers/chatCore.ts");
const { waitForCallLogSaves } = await import("../../src/lib/usage/callLogs.ts");
const { __resetRateLimitManagerForTests } =
  await import("../../open-sse/services/rateLimitManager.ts");
const billingMessage =
  "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.";
const originalFetch = globalThis.fetch;

test.after(async () => {
  globalThis.fetch = originalFetch;
  await waitForCallLogSaves(10_000);
  await __resetRateLimitManagerForTests();
  core.resetDbInstance();
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("Anthropic billing 400 is request-scoped across string and JSON envelopes", () => {
  for (const body of [
    billingMessage,
    { error: { type: "invalid_request_error", message: billingMessage } },
  ]) {
    assert.equal(classifyProviderError(400, body, "anthropic"), "billing_request_rejected");
  }
  const decision = checkFallbackError(400, billingMessage, 0, "claude-opus-5-5", "anthropic");
  assert.equal(decision.shouldFallback, false);
  assert.equal(decision.cooldownMs, 0);
  assert.ok(!decision.creditsExhausted);
});

test("other providers and explicit payment statuses retain account-wide billing handling", () => {
  for (const [provider, status] of [
    ["openai", 400],
    ["claude", 400],
    ["anthropic", 402],
  ] as const) {
    assert.equal(classifyProviderError(status, billingMessage, provider), "quota_exhausted");
    assert.equal(
      checkFallbackError(status, billingMessage, 0, null, provider).creditsExhausted,
      true
    );
  }
  assert.equal(classifyProviderError(401, "invalid API key", "anthropic"), "unauthorized");
  assert.equal(classifyProviderError(429, "rate limit exceeded", "anthropic"), "rate_limited");
  assert.equal(
    checkFallbackError(400, "invalid messages", 0, null, "anthropic").shouldFallback,
    false
  );
});

test("billing rejection does not disable, cool, or lock any of three usable API accounts", async () => {
  const accounts = await Promise.all(
    ["Bruno", "Amauri", "Guilherme"].map((name) =>
      providers.createProviderConnection({
        provider: "anthropic",
        name,
        authType: "apikey",
        apiKey: "test-billing-key-" + name,
        isActive: true,
        testStatus: "active",
      })
    )
  );
  for (const account of accounts) {
    const decision = await markAccountUnavailable(
      account.id,
      400,
      billingMessage,
      "anthropic",
      "claude-opus-5-5"
    );
    assert.equal(decision.shouldFallback, false);
    assert.equal(decision.cooldownMs, 0);
    const after = await providers.getProviderConnectionById(account.id);
    assert.equal(after.isActive, true);
    assert.equal(after.testStatus, "active");
    assert.ok(!after.rateLimitedUntil);
    assert.equal(getModelLockoutInfo("anthropic", account.id, "claude-opus-5-5"), null);
  }
  const selected = await getProviderCredentials("anthropic");
  assert.ok(selected?.connectionId);
  assert.ok(!selected?.allExpired);
});

for (const stream of [false, true]) {
  test(`chatCore preserves an active account and returns the billing 400 (stream=${stream})`, async () => {
    const account = await providers.createProviderConnection({
      provider: "anthropic",
      authType: "apikey",
      apiKey: "test-core-billing-" + stream,
      isActive: true,
      testStatus: "active",
    });
    let calls = 0;
    globalThis.fetch = async (_url, init) => {
      calls += 1;
      assert.match(
        new Headers(init?.headers).get("anthropic-beta") || "",
        /claude-code-20250219/,
        "genuine client identity must be preserved"
      );
      return new Response(
        JSON.stringify({ error: { type: "invalid_request_error", message: billingMessage } }),
        { status: 400, headers: { "content-type": "application/json" } }
      );
    };
    try {
      const body = {
        model: "claude-opus-5-5",
        max_tokens: 128,
        stream,
        messages: [{ role: "user", content: "hello" }],
      };
      const result = await handleChatCore({
        body,
        modelInfo: { provider: "anthropic", model: "claude-opus-5-5" },
        credentials: {
          connectionId: account.id,
          apiKey: "test-core-billing",
          providerSpecificData: {},
        },
        connectionId: account.id,
        sourceFormat: "claude",
        log: { debug() {}, info() {}, warn() {}, error() {} },
        clientRawRequest: {
          endpoint: "/v1/messages",
          body,
          headers: new Headers({
            accept: stream ? "text/event-stream" : "application/json",
            "x-app": "cli",
          }),
        },
        userAgent: "claude-cli/2.1.220",
      });
      assert.equal(result.success, false);
      assert.equal(result.status, 400);
      assert.match(String(result.error), /credit balance is too low/);
      await result.response.text();
      assert.equal(calls, 1, "billing rejection must not rotate or retry the account");
      const after = await providers.getProviderConnectionById(account.id);
      assert.equal(after.isActive, true);
      assert.equal(after.testStatus, "active");
      assert.ok(!after.rateLimitedUntil);
    } finally {
      globalThis.fetch = originalFetch;
      await waitForCallLogSaves(10_000);
    }
  });
}
