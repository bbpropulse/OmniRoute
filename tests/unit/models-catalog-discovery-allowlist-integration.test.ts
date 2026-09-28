import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-discovery-allowlist-"));
process.env.DATA_DIR = dataDir;
process.env.API_KEY_SECRET = "discovery-allowlist-test-secret";
const names = ["claude-haiku-4-5-20251001", "claude-sonnet-5", "claude-opus-5", "claude-fable-5-1"];
const allowed = names.map((name) => `claude/${name}`);
process.env.MODEL_DISCOVERY_ALLOWLIST = allowed.join(",");

const core = await import("../../src/lib/db/core.ts");
const keys = await import("../../src/lib/db/apiKeys.ts");
const providers = await import("../../src/lib/db/providers.ts");
const models = await import("../../src/lib/db/models.ts");
const catalog = await import("../../src/app/api/v1/models/catalog.ts");

test.before(async () => {
  await providers.createProviderConnection({
    provider: "claude",
    authType: "oauth",
    name: "discovery-test",
    accessToken: "test-access-token",
    isActive: true,
    testStatus: "active",
    providerSpecificData: {},
  });
  for (const name of names) await models.addCustomModel("claude", name);
});

test.after(() => {
  core.resetDbInstance();
  keys.resetApiKeyState();
  delete process.env.MODEL_DISCOVERY_ALLOWLIST;
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

async function discover(apiKey: string, query = "") {
  const response = await catalog.getUnifiedModelsResponse(
    new Request(`http://localhost/api/v1/models${query}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    })
  );
  assert.equal(response.status, 200);
  const body = (await response.json()) as { data: Array<{ id: string }> };
  return body.data.map((model) => model.id).sort();
}

test("a newly created unrestricted key sees exactly the four configured public IDs", async () => {
  const key = await keys.createApiKey("new-unrestricted", "test-machine");
  assert.deepEqual(await discover(key.key), [...allowed].sort());
  assert.deepEqual(await discover(key.key, "?prefix=canonical"), [...allowed].sort());
});

test("existing cc-prefixed permissions work with claude-prefixed discovery", async () => {
  const key = await keys.createApiKey("restricted", "test-machine");
  await keys.updateApiKeyPermissions(key.id, { allowedModels: [`cc/${names[0]}`] });
  assert.deepEqual(await discover(key.key), [allowed[0]]);
});
