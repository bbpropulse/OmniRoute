import test from "node:test";
import assert from "node:assert/strict";
import { DefaultExecutor } from "../../open-sse/executors/default.ts";
import { resetDbInstance } from "../../src/lib/db/core.ts";

test.after(() => resetDbInstance());

const CC_BETA = "claude-code-20250219";
const credentials = { apiKey: "test-api-key", providerSpecificData: {} };

function betaTokens(headers: Record<string, string>): string[] {
  return Object.entries(headers)
    .filter(([name]) => name.toLowerCase() === "anthropic-beta")
    .flatMap(([, value]) => value.split(",").map((token) => token.trim()));
}

test("ordinary Anthropic API calls do not advertise Claude Code", () => {
  const executor = new DefaultExecutor("anthropic");
  for (const clientHeaders of [undefined, { "User-Agent": "propulse-crm/1.0" }]) {
    const headers = executor.buildHeaders(credentials, false, clientHeaders, "claude-opus-5-5");
    assert.ok(!betaTokens(headers).includes(CC_BETA));
    assert.ok(betaTokens(headers).includes("advanced-tool-use-2025-11-20"));
    assert.equal(headers["x-api-key"], "test-api-key");
  }
});

test("real Claude Code callers retain their client identity", () => {
  const executor = new DefaultExecutor("anthropic");
  for (const clientHeaders of [
    { "x-app": "cli" },
    { "User-Agent": "claude-cli/2.1.220" },
    { "user-agent": "claude-code/2.1.220" },
    { "Anthropic-Beta": `effort-2025-11-24, ${CC_BETA}` },
  ]) {
    const before = { ...clientHeaders };
    const headers = executor.buildHeaders(credentials, false, clientHeaders, "claude-opus-5-5");
    assert.ok(betaTokens(headers).includes(CC_BETA));
    assert.deepEqual(clientHeaders, before);
  }
});

test("Claude OAuth and non-API-key Anthropic authentication keep their existing identity", () => {
  for (const provider of ["claude", "anthropic"]) {
    const executor = new DefaultExecutor(provider);
    const headers = executor.buildHeaders({ accessToken: "test-oauth-token" }, false);
    assert.ok(betaTokens(headers).includes(CC_BETA));
    assert.equal(headers.Authorization, "Bearer test-oauth-token");
  }
});
