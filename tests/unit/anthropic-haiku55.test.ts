import test from "node:test";
import assert from "node:assert/strict";
import { getModelSpec } from "../../src/shared/constants/modelSpecs.ts";
import { getUnsupportedParams } from "../../open-sse/config/providerRegistry.ts";
import { getProviderModel, supportsClaudeMaxEffort } from "../../open-sse/config/providerModels.ts";
import { normalizeClaudeHaikuConstraints } from "../../open-sse/services/claudeHaikuConstraints.ts";
import { normalizeClaudeAdaptiveThinking } from "../../open-sse/services/claudeAdaptiveThinking.ts";
import { openaiToClaudeRequest } from "../../open-sse/translator/request/openai-to-claude.ts";
import { resetDbInstance } from "../../src/lib/db/core.ts";

test.after(() => resetDbInstance());
const MODEL = "claude-haiku-5-5";
const EFFORTS = ["low", "medium", "high", "xhigh"];

test("the native Anthropic catalog retains Haiku 5.5 with its limits and sampling restrictions", () => {
  const entry = getProviderModel("anthropic", MODEL);
  assert.ok(entry, "the configured native model must survive an upstream registry upgrade");
  assert.equal(entry.contextLength, 1000000);
  assert.equal(entry.maxOutputTokens, 128000);
  assert.equal(entry.supportsReasoning, true);
  assert.equal(entry.supportsVision, true);
  assert.deepEqual(entry.supportedThinkingEfforts, EFFORTS);
  const spec = getModelSpec(MODEL);
  assert.equal(spec?.contextWindow, 1000000);
  assert.equal(spec?.maxOutputTokens, 128000);
  assert.equal(spec?.adaptiveThinkingOnly, true);
  for (const param of ["temperature", "top_p", "top_k"]) {
    assert.ok(getUnsupportedParams("anthropic", MODEL).includes(param));
  }
});

test("Haiku 5.5 keeps adaptive thinking in native Messages requests", () => {
  for (const effort of EFFORTS) {
    const body = { thinking: { type: "adaptive" }, output_config: { effort } };
    assert.equal(normalizeClaudeHaikuConstraints(body, MODEL), body);
  }
});

test("OpenAI reasoning efforts route to Haiku 5.5 without legacy manual budgets", () => {
  for (const effort of EFFORTS) {
    const body = { reasoning_effort: effort, messages: [{ role: "user", content: "hi" }] };
    const out = openaiToClaudeRequest(MODEL, body, false, null);
    assert.deepEqual(out.thinking, { type: "adaptive" });
    assert.equal(out.output_config?.effort, effort);
  }
  // The configured -max discovery alias remains compatible while the new
  // upstream normalization still controls the effort actually sent upstream.
  assert.equal(supportsClaudeMaxEffort(MODEL), false);
  const out = openaiToClaudeRequest(
    MODEL,
    { reasoning_effort: "max", messages: [{ role: "user", content: "hi" }] },
    false,
    null
  );
  assert.deepEqual(out.thinking, { type: "adaptive" });
  assert.equal(out.output_config?.effort, "high");
});

test("Haiku 5.5 legacy manual thinking is normalized before dispatch", () => {
  const body = { thinking: { type: "enabled", budget_tokens: 10000 } };
  assert.deepEqual(normalizeClaudeAdaptiveThinking(body, MODEL).thinking, { type: "adaptive" });
});

test("older Haiku models retain their legacy restrictions", () => {
  const body = { thinking: { type: "adaptive" }, output_config: { effort: "high" } };
  const out = normalizeClaudeHaikuConstraints(body, "claude-haiku-4-5-20251001");
  assert.equal(out.thinking.type, "enabled");
  assert.equal(out.output_config, undefined);
  assert.equal(supportsClaudeMaxEffort("claude-haiku-4-5-20251001"), false);
});
