import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "catalog-discovery-allowlist-"));
process.env.DATA_DIR = dataDir;
const originalAllowlist = process.env.MODEL_DISCOVERY_ALLOWLIST;
const { resetDbInstance } = await import("../../src/lib/db/core.ts");
const { applyCatalogPostFilters, finalizeCatalogResponse } =
  await import("../../src/app/api/v1/models/catalogResponse.ts");
const { appendConfiguredClaudeEffortAliases, filterCatalogByAllowlist } =
  await import("../../src/app/api/v1/models/catalogAllowlist.ts");

test.afterEach(() => {
  if (originalAllowlist === undefined) delete process.env.MODEL_DISCOVERY_ALLOWLIST;
  else process.env.MODEL_DISCOVERY_ALLOWLIST = originalAllowlist;
});

test.after(() => {
  resetDbInstance();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("the public catalog applies the deployment allowlist after caller permissions", async () => {
  process.env.MODEL_DISCOVERY_ALLOWLIST =
    "anthropic/claude-sonnet-5-5-medium,anthropic/claude-opus-5-5-high";
  // These are the entries the caller has already been authorized to discover.
  // A configured but unauthorized Opus entry must never be manufactured here.
  const authorized = [
    { id: "anthropic/claude-sonnet-5-5", owned_by: "combo" },
    { id: "anthropic/claude-sonnet-5-5-medium", owned_by: "combo" },
    { id: "cx/gpt-6-sol", owned_by: "combo" },
  ];
  const response = await finalizeCatalogResponse(
    new Request("http://localhost/v1/models"),
    authorized,
    () => undefined,
    {}
  );
  const body = await response.json();
  assert.deepEqual(
    body.data.map((model: { id: string }) => model.id),
    ["anthropic/claude-sonnet-5-5-medium"]
  );
  assert.equal(response.status, 200);
});

test("an invalid deployment allowlist keeps the public catalog closed", async () => {
  process.env.MODEL_DISCOVERY_ALLOWLIST = "anthropic/*";
  const response = await finalizeCatalogResponse(
    new Request("http://localhost/v1/models?limit=1"),
    [{ id: "anthropic/claude-sonnet-5-5", owned_by: "combo" }],
    () => undefined,
    {}
  );
  assert.deepEqual(await response.json(), { object: "list", data: [], has_more: false });
});

test("an unset allowlist leaves the existing catalog unchanged", () => {
  const models = [{ id: "anthropic/claude-sonnet-5-5" }];
  assert.equal(filterCatalogByAllowlist(models, undefined, {}), models);
});

test("the allowlist keeps configured order without granting missing models", () => {
  const models = [
    { id: "anthropic/claude-sonnet-5-5", label: "Sonnet" },
    { id: "anthropic/claude-opus-5-5", label: "Opus" },
    { id: "cx/gpt-6-sol", label: "Sol" },
  ];
  assert.deepEqual(
    filterCatalogByAllowlist(
      models,
      "anthropic/claude-opus-5-5,anthropic/missing,anthropic/claude-sonnet-5-5",
      {}
    ),
    [models[1], models[0]]
  );
});

test("provider aliases match canonical identities while effort suffixes remain exact", () => {
  const models = [
    { id: "cx/gpt-6-sol-high", label: "authorized" },
    { id: "cx/gpt-6-sol", label: "base" },
    { id: "cx/gpt-6-sol-max", label: "max" },
  ];
  const aliases = { cx: "codex", codex: "codex" };
  assert.deepEqual(filterCatalogByAllowlist(models, "codex/gpt-6-sol-high", aliases), [
    { id: "codex/gpt-6-sol-high", label: "authorized" },
  ]);
  assert.deepEqual(filterCatalogByAllowlist(models, "codex/gpt-6-sol-medium", aliases), []);
});

test("duplicate provider aliases keep only the first configured public id and metadata", () => {
  const models = [
    { id: "cx/gpt-6-sol", label: "first" },
    { id: "codex/gpt-6-sol", label: "second" },
  ];
  assert.deepEqual(
    filterCatalogByAllowlist(models, "codex/gpt-6-sol,cx/gpt-6-sol", {
      cx: "codex",
      codex: "codex",
    }),
    [{ id: "codex/gpt-6-sol", label: "first" }]
  );
});

test("empty, wildcard, malformed and oversized allowlists fail closed", () => {
  const models = [{ id: "anthropic/claude-sonnet-5-5" }];
  for (const invalid of [
    "",
    " ",
    "anthropic/*",
    "anthropic//claude-sonnet-5-5",
    "anthropic/claude sonnet",
    "anthropic/claude-sonnet-5-5,",
    "a".repeat(513),
    Array.from({ length: 257 }, () => "anthropic/claude-sonnet-5-5").join(","),
    "a".repeat(65537),
  ]) {
    assert.deepEqual(filterCatalogByAllowlist(models, invalid, {}), [], invalid.slice(0, 80));
  }
});

test("filtering does not mutate input entries or infer inherited provider aliases", () => {
  const entry = Object.freeze({ id: "constructor/model", label: "kept" });
  const models = [entry, { id: 42 }];
  assert.deepEqual(filterCatalogByAllowlist(models, "constructor/model", {}), [entry]);
  assert.equal(entry.id, "constructor/model");
  assert.equal(models.length, 2);
});

test("configured legacy Max aliases survive discovery without advertising unsupported tiers", async () => {
  process.env.MODEL_DISCOVERY_ALLOWLIST = "anthropic/claude-sonnet-5-5-max";
  const tiers = ["low", "medium", "high", "xhigh"];
  const models = await applyCatalogPostFilters(
    new Request("http://localhost/v1/models"),
    [
      {
        id: "anthropic/claude-sonnet-5-5",
        owned_by: "anthropic",
        name: "Claude Sonnet 5.5",
        capabilities: { effort_tiers: tiers },
      },
    ],
    {
      connections: [],
      prefixMode: "canonical",
      aliasToProviderId: { anthropic: "anthropic" },
      hideNoThinkVariants: true,
      authorizeSyntheticModel: () => true,
    }
  );
  const legacy = models.find((model) => model.id === "anthropic/claude-sonnet-5-5-max");
  assert.ok(legacy, "an explicitly configured compatibility alias must remain discoverable");
  assert.deepEqual(legacy.capabilities.effort_tiers, tiers);
  assert.ok(!legacy.capabilities.effort_tiers.includes("max"));
});

test("a denied synthetic Max alias cannot bypass the caller's model restrictions", async () => {
  process.env.MODEL_DISCOVERY_ALLOWLIST = "anthropic/claude-sonnet-5-5-max";
  const models = await applyCatalogPostFilters(
    new Request("http://localhost/v1/models"),
    [{ id: "anthropic/claude-sonnet-5-5", owned_by: "anthropic" }],
    {
      connections: [],
      prefixMode: "canonical",
      aliasToProviderId: { anthropic: "anthropic" },
      hideNoThinkVariants: true,
      authorizeSyntheticModel: (model) => !String(model.id).endsWith("-max"),
    }
  );
  assert.ok(!models.some((model) => model.id === "anthropic/claude-sonnet-5-5-max"));
});

test("legacy Max aliases require an explicit native 5.5 entry and visible base", () => {
  const models = [
    { id: "anthropic/claude-haiku-5-5", owned_by: "anthropic", name: "Haiku" },
    { id: "claude/claude-opus-5-5", owned_by: "claude", name: "Opus" },
    { id: "claude/claude-sonnet-5-5", owned_by: "combo", name: "Virtual" },
    { id: "github/claude-sonnet-5-5", owned_by: "github", name: "Copilot" },
    { id: "anthropic/claude-opus-5", owned_by: "anthropic", name: "Earlier" },
  ];
  const configured = [
    "anthropic/claude-haiku-5-5-max",
    "anthropic/claude-opus-5-5-max", // Base not visible in this provider.
    "cc/claude-opus-5-5-max",
    "claude/claude-sonnet-5-5-max", // A virtual row cannot grant a native alias.
    "github/claude-sonnet-5-5-max",
    "anthropic/claude-opus-5-max",
  ].join(",");
  const result = appendConfiguredClaudeEffortAliases(models, configured, { cc: "claude" });
  assert.deepEqual(
    result.slice(models.length).map((model) => model.id),
    ["anthropic/claude-haiku-5-5-max", "cc/claude-opus-5-5-max"]
  );
  assert.equal(result[models.length].root, "claude-haiku-5-5-max");
  assert.equal(result[models.length].name, "Haiku (Max)");
  assert.equal(models.length, 5);
});

test("unconfigured or invalid compatibility aliases leave the input unchanged", () => {
  const models = [{ id: "anthropic/claude-sonnet-5-5", owned_by: "anthropic" }];
  for (const config of [undefined, "", "anthropic/*", "anthropic/claude-sonnet-5-5-high"]) {
    assert.equal(appendConfiguredClaudeEffortAliases(models, config, {}), models);
  }
});

test("an existing Max alias is preserved without generating duplicates", () => {
  const models = [
    { id: "claude/claude-opus-5-5", owned_by: "claude" },
    { id: "claude/claude-opus-5-5-max", owned_by: "claude" },
  ];
  assert.equal(
    appendConfiguredClaudeEffortAliases(models, "cc/claude-opus-5-5-max", { cc: "claude" }),
    models
  );
});
