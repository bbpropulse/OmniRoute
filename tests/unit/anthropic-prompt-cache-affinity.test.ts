import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omni-anthropic-cache-affinity-"));
process.env.DATA_DIR = dataDir;
process.env.API_KEY_SECRET = "cache-affinity-test-secret";

const core = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const settingsDb = await import("../../src/lib/db/settings.ts");
const apiKeysDb = await import("../../src/lib/db/apiKeys.ts");
const affinityDb = await import("../../src/lib/db/sessionAccountAffinity.ts");
const auth = await import("../../src/sse/services/auth.ts");
const affinity = await import("../../src/sse/services/sessionAffinityPin.ts");
const { updateSettingsSchema } = await import("../../src/shared/validation/settingsSchemas.ts");
const { prepareClaudeRequest } = await import("../../open-sse/translator/helpers/claudeHelper.ts");
const { translateRequest } = await import("../../open-sse/translator/index.ts");
const { FORMATS } = await import("../../open-sse/translator/formats.ts");
const hour = 3_600_000;
const scopedSettings = {
  sessionAffinityTtlMs: 0,
  providerSessionAffinityTtlMs: { claude: hour, anthropic: hour },
};

test.after(() => {
  core.resetDbInstance();
  apiKeysDb.resetApiKeyState();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("OpenAI to Anthropic translation retains generated cache breakpoints", () => {
  const result = translateRequest(
    FORMATS.OPENAI,
    FORMATS.CLAUDE,
    "claude-sonnet-5-5",
    {
      model: "claude-sonnet-5-5",
      messages: [
        { role: "system", content: "Stable reusable instructions" },
        { role: "user", content: "First question" },
        { role: "assistant", content: "First answer" },
        { role: "user", content: "Next question" },
      ],
      tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object" } } }],
    },
    false,
    {},
    "anthropic"
  );
  assert.deepEqual(result.system.at(-1).cache_control, { type: "ephemeral", ttl: "1h" });
  assert.deepEqual(result.tools.at(-1).cache_control, { type: "ephemeral", ttl: "1h" });
  assert.ok(
    result.messages.some(
      (message) =>
        Array.isArray(message.content) && message.content.some((block) => block.cache_control)
    )
  );
});

for (const provider of ["claude", "anthropic"]) {
  test(`${provider} preserves client-selected cache boundaries and TTL`, () => {
    const body = {
      system: [
        { type: "text", text: "Stable prefix", cache_control: { type: "ephemeral", ttl: "5m" } },
      ],
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "Question", cache_control: { type: "ephemeral" } }],
        },
      ],
    };
    const result = prepareClaudeRequest(structuredClone(body), provider, true, "claude-sonnet-5-5");
    assert.deepEqual(result.system, body.system);
    assert.deepEqual(result.messages, body.messages);
  });
}

test("provider-scoped affinity overrides preserve unrelated provider defaults", () => {
  assert.equal(affinity.resolveSessionAffinityTtlMs("claude", {}, scopedSettings), hour);
  assert.equal(affinity.resolveSessionAffinityTtlMs("anthropic", {}, scopedSettings), hour);
  assert.equal(affinity.resolveSessionAffinityTtlMs("codex", {}, scopedSettings), 0);
  assert.equal(affinity.resolveSessionAffinityTtlMs("openai", {}, scopedSettings), 0);
  assert.equal(
    affinity.resolveSessionAffinityTtlMs(
      "anthropic",
      { sessionAffinityTtlMs: 60_000 },
      scopedSettings
    ),
    60_000
  );
  assert.equal(
    affinity.resolveSessionAffinityTtlMs(
      "claude",
      {},
      {
        sessionAffinityTtlMs: hour,
        providerSessionAffinityTtlMs: { claude: 0 },
      }
    ),
    0
  );
  assert.equal(
    affinity.resolveSessionAffinityTtlMs("openai", {}, { sessionAffinityTtlMs: 90_000 }),
    90_000
  );
});

test("settings schema accepts scoped TTLs and rejects invalid durations", () => {
  const parsed = updateSettingsSchema.parse(scopedSettings);
  assert.deepEqual(
    parsed.providerSessionAffinityTtlMs,
    scopedSettings.providerSessionAffinityTtlMs
  );
  for (const value of [-1, 86_400_001, 1.5, "3600000"]) {
    assert.equal(
      updateSettingsSchema.safeParse({ providerSessionAffinityTtlMs: { claude: value } }).success,
      false
    );
  }
});

test("Claude Code session identity survives history compaction", () => {
  const userId = JSON.stringify({
    device_id: "test-device",
    account_uuid: "test-account",
    session_id: "conversation-a",
  });
  const first = {
    metadata: { user_id: userId },
    messages: [{ role: "user", content: "Original request" }],
  };
  const compacted = {
    metadata: { user_id: userId },
    messages: [{ role: "user", content: "Compacted history" }],
  };
  assert.equal(affinity.extractSessionAffinityKey(first), "claude-code:conversation-a");
  assert.equal(
    affinity.extractSessionAffinityKey(first),
    affinity.extractSessionAffinityKey(compacted)
  );
  assert.notEqual(
    affinity.extractSessionAffinityKey(first),
    affinity.extractSessionAffinityKey({
      ...first,
      metadata: { user_id: JSON.stringify({ session_id: "conversation-b" }) },
    })
  );
  assert.equal(
    affinity.extractSessionAffinityKey(first, new Headers({ "x-session-id": "header-session" })),
    "header:header-session"
  );
  assert.equal(
    affinity.extractSessionAffinityKey({
      ...first,
      metadata: { session_id: "explicit", user_id: userId },
    }),
    "metadata:explicit"
  );
});

test("malformed or oversized client metadata safely falls back to input identity", () => {
  const fallback = { messages: [{ role: "user", content: "Question" }] };
  for (const user_id of [
    "not-json",
    "{",
    "x".repeat(5000),
    JSON.stringify({ session_id: 42 }),
    JSON.stringify({ account_uuid: "account-only" }),
  ]) {
    assert.equal(
      affinity.extractSessionAffinityKey({ ...fallback, metadata: { user_id } }),
      affinity.extractSessionAffinityKey(fallback)
    );
  }
});

for (const provider of ["claude", "anthropic"]) {
  test(`${provider} reuses a healthy pinned account and fails over when excluded`, async () => {
    await settingsDb.updateSettings({
      ...scopedSettings,
      providerStrategies: { [provider]: { fallbackStrategy: "random" } },
    });
    const seed = (name: string) =>
      providersDb.createProviderConnection({
        provider,
        authType: provider === "claude" ? "oauth" : "api_key",
        name,
        ...(provider === "claude"
          ? { accessToken: `test-access-${name}` }
          : { apiKey: `test-key-${name}` }),
        isActive: true,
        testStatus: "active",
      });
    await seed(`${provider}-a`);
    await seed(`${provider}-b`);
    const sessionKey = `test-session-${provider}`;
    const first = await auth.getProviderCredentials(provider, null, null, "claude-sonnet-5-5", {
      sessionKey,
    });
    assert.ok(first?.connectionId);
    const pin = affinityDb.getSessionAccountAffinity(sessionKey, provider, hour);
    assert.equal(pin?.connectionId, first.connectionId);
    assert.equal(Date.parse(pin.expiresAt) - Date.parse(pin.lastUsedAt), hour);
    for (let i = 0; i < 4; i++) {
      const next = await auth.getProviderCredentials(provider, null, null, "claude-sonnet-5-5", {
        sessionKey,
      });
      assert.equal(next?.connectionId, first.connectionId);
    }
    const sibling = await auth.getProviderCredentials(provider, null, null, "claude-sonnet-5-5", {
      sessionKey,
      excludeConnectionIds: [first.connectionId],
    });
    assert.ok(sibling?.connectionId);
    assert.notEqual(sibling.connectionId, first.connectionId);
    assert.equal(
      affinityDb.getSessionAccountAffinity(sessionKey, provider, hour)?.connectionId,
      sibling.connectionId
    );
  });
}
