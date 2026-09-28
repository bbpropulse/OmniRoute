import test from "node:test";
import assert from "node:assert/strict";
import { getModelSpec, normalizeThinkingForModel } from "../../src/shared/constants/modelSpecs.ts";
import { getStaticModelsForProvider } from "../../src/lib/providers/staticModels.ts";
import { appendClaudeEffortVariants } from "../../open-sse/utils/claudeEffortVariants.ts";
import { shouldExposeNoThinkingAlias } from "../../open-sse/utils/noThinkingAlias.ts";
import { applyClaudeEffortVariant } from "../../open-sse/handlers/chatCore/claudeEffortVariant.ts";

const base = "claude-sonnet-5-5";
const levels = ["low", "medium", "high", "xhigh", "max"];

test("Sonnet 5.5 uses its own 1M adaptive-thinking specification", () => {
  for (const id of [base, `${base}-low`, `${base}-max`, `anthropic.${base}`]) {
    const spec = getModelSpec(id);
    assert.equal(spec?.contextWindow, 1_000_000);
    assert.equal(spec?.maxOutputTokens, 128_000);
    assert.equal(spec?.adaptiveThinkingOnly, true);
    assert.equal(spec?.rejectsThinkingDisabled, true);
    assert.deepEqual(spec?.effortLevels, levels);
  }
  assert.notEqual(getModelSpec("claude-sonnet-5")?.rejectsThinkingDisabled, true);
});

test("Sonnet 5.5 drops unsupported disabled thinking without changing effort", () => {
  const body = { thinking: { type: "disabled" }, output_config: { effort: "low" } };
  const normalized = normalizeThinkingForModel(body, base);
  assert.equal("thinking" in normalized, false);
  assert.deepEqual(normalized.output_config, { effort: "low" });
  assert.equal(shouldExposeNoThinkingAlias({ id: `claude/${base}`, owned_by: "claude" }), false);
});

test("Sonnet 5.5 is discoverable with all five effort variants", () => {
  assert.equal(
    getStaticModelsForProvider("claude")?.some((model) => model.id === base),
    true
  );
  const entry = { id: `claude/${base}`, owned_by: "claude", context_window: 1_000_000 };
  const catalog = appendClaudeEffortVariants([entry]);
  assert.deepEqual(
    catalog.map((model) => model.id),
    [entry.id, ...levels.map((level) => `${entry.id}-${level}`)]
  );
  for (const effort of levels) {
    const body: Record<string, unknown> = { model: `${base}-${effort}` };
    const result = applyClaudeEffortVariant({
      provider: "claude",
      effectiveModel: base,
      resolvedThinkingEffort: effort,
      body,
      sourceFormat: "openai",
    });
    assert.equal(result.effectiveModel, base);
    assert.equal(body.reasoning_effort, effort);
  }
});
