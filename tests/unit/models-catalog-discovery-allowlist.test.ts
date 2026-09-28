import assert from "node:assert/strict";
import { test } from "node:test";
import { filterCatalogByAllowlist } from "../../src/app/api/v1/models/catalogAllowlist";

const aliases = { cc: "claude", claude: "claude", oc: "opencode" };
const names = ["claude-haiku-4-5-20251001", "claude-sonnet-5", "claude-opus-5", "claude-fable-5-1"];
const allowed = names.map((name) => `claude/${name}`);
const models = names.flatMap((name) => [
  { id: `cc/${name}`, owned_by: "claude", context_length: 1000000 },
  { id: `claude/${name}`, owned_by: "claude", context_length: 1000000 },
  { id: `claude/${name}-high`, owned_by: "claude" },
  { id: `claude/${name}-no-think`, owned_by: "claude" },
  { id: `oc/${name}`, owned_by: "opencode" },
]);

test("unset discovery allowlist preserves the existing catalog", () => {
  assert.equal(filterCatalogByAllowlist(models, undefined, aliases), models);
});

test("only four configured IDs survive provider aliases, variants and other providers", () => {
  const original = structuredClone(models);
  const result = filterCatalogByAllowlist(
    [...models, { id: "auto", owned_by: "combo" }],
    allowed.join(","),
    aliases
  );
  assert.deepEqual(
    result.map((model) => model.id),
    allowed
  );
  assert.equal(result[0].context_length, 1000000);
  assert.equal(result[0].owned_by, "claude");
  assert.deepEqual(models, original);
});

test("a restricted key's catalog is never expanded by the global allowlist", () => {
  const result = filterCatalogByAllowlist([models[0]], allowed.join(","), aliases);
  assert.deepEqual(
    result.map((model) => model.id),
    [allowed[0]]
  );
  assert.deepEqual(filterCatalogByAllowlist([], allowed.join(","), aliases), []);
});

test("aliases in configuration collapse to the first configured public ID", () => {
  const result = filterCatalogByAllowlist(models, ` cc/${names[0]}, claude/${names[0]} `, aliases);
  assert.deepEqual(
    result.map((model) => model.id),
    [`cc/${names[0]}`]
  );
});

test("empty or invalid configuration fails closed instead of exposing all models", () => {
  for (const value of ["", " ", "*", "claude/*", "claude/", ",", "x".repeat(65537)]) {
    assert.deepEqual(filterCatalogByAllowlist(models, value, aliases), []);
  }
});

test("same model name at an unlisted provider does not match", () => {
  assert.deepEqual(
    filterCatalogByAllowlist([{ id: `oc/${names[0]}` }], allowed.join(","), aliases),
    []
  );
});

test("unprefixed combos can be listed explicitly without matching provider model IDs", () => {
  assert.deepEqual(filterCatalogByAllowlist([{ id: "auto" }, ...models], "auto", aliases), [
    { id: "auto" },
  ]);
});
