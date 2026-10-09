import test from "node:test";
import assert from "node:assert/strict";
import { getModelSpec } from "../../src/shared/constants/modelSpecs.ts";
import { getUnsupportedParams } from "../../open-sse/config/providerRegistry.ts";
import { supportsClaudeMaxEffort } from "../../open-sse/config/providerModels.ts";
import { normalizeClaudeHaikuConstraints } from "../../open-sse/services/claudeHaikuConstraints.ts";
import { normalizeClaudeAdaptiveThinking } from "../../open-sse/services/claudeAdaptiveThinking.ts";
import { openaiToClaudeRequest } from "../../open-sse/translator/request/openai-to-claude.ts";
import { resetDbInstance } from "../../src/lib/db/core.ts";

test.after(() => resetDbInstance());
const MODEL = "claude-haiku-5-5";
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];

test("Haiku 5.5 advertises 1M context, 128K output and all five efforts", () => {
  const spec = getModelSpec(MODEL);
  assert.equal(spec?.contextWindow, 1000000);
  assert.equal(spec?.maxOutputTokens, 128000);
  assert.deepEqual(spec?.effortLevels, EFFORTS);
  assert.equal(spec?.rejectsThinkingDisabled, undefined);
  assert.equal(spec?.maxEffortWhenThinkingDisabled, "high");
  for (const param of ["temperature", "top_p", "top_k"]) {
    assert.ok(getUnsupportedParams("anthropic", MODEL).includes(param));
  }
});

test("Haiku 5.5 preserves adaptive thinking and effort in native Messages requests", () => {
  for (const model of [MODEL, "anthropic/claude-haiku-5.5", "us.anthropic.claude-haiku-5-5"]) {
    for (const effort of EFFORTS) {
      const body = { thinking: { type: "adaptive" }, output_config: { effort } };
      assert.equal(normalizeClaudeHaikuConstraints(body, model), body);
    }
    assert.equal(supportsClaudeMaxEffort(model), true);
  }
});

test("OpenAI reasoning efforts route to Haiku 5.5 adaptive thinking without manual budgets", () => {
  for (const effort of EFFORTS) {
    const body = { reasoning_effort: effort, messages: [{ role: "user", content: "hi" }] };
    const out = openaiToClaudeRequest(MODEL, body, false, null);
    assert.deepEqual(out.thinking, { type: "adaptive" });
    assert.equal(out.output_config?.effort, effort);
  }
  const out = openaiToClaudeRequest(
    MODEL,
    { thinking: { type: "adaptive" }, messages: [{ role: "user", content: "hi" }] },
    false,
    null
  );
  assert.deepEqual(out.thinking, { type: "adaptive" });
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
