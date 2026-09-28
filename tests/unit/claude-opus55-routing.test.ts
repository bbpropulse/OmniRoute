import test from "node:test";
import assert from "node:assert/strict";
import { getModelSpec, normalizeThinkingForModel } from "../../src/shared/constants/modelSpecs.ts";
import {
  appendClaudeEffortVariants,
  shouldExposeClaudeEffortVariants,
} from "../../open-sse/utils/claudeEffortVariants.ts";
import { shouldExposeNoThinkingAlias } from "../../open-sse/utils/noThinkingAlias.ts";
import { normalizeClaudeAdaptiveThinking } from "../../open-sse/services/claudeAdaptiveThinking.ts";
import { applyClaudeEffortVariant } from "../../open-sse/handlers/chatCore/claudeEffortVariant.ts";
import { resolveClaudeCodeCompatibleEffort } from "../../open-sse/services/claudeCodeCompatible.ts";

const base = "claude-opus-5-5";
const levels = ["low", "medium", "high", "xhigh", "max"];

test("Opus 5.5 uses its own always-on adaptive specification, including effort variants", () => {
  for (const id of [base, `${base}-high`, `${base}-max`, "anthropic.claude-opus-5-5"]) {
    const spec = getModelSpec(id);
    assert.equal(spec?.contextWindow, 1_000_000);
    assert.equal(spec?.maxOutputTokens, 128_000);
    assert.equal(spec?.adaptiveThinkingOnly, true);
    assert.equal(spec?.rejectsThinkingDisabled, true);
    assert.equal(spec?.maxEffortWhenThinkingDisabled, undefined);
    assert.equal(spec?.defaultReasoningEffort, "medium");
  }
  assert.notEqual(getModelSpec("claude-opus-5")?.rejectsThinkingDisabled, true);
});

test("Opus 5.5 defaults to medium effort unless the caller selects another level", () => {
  assert.equal(resolveClaudeCodeCompatibleEffort({}, {}, base), "medium");
  assert.equal(
    resolveClaudeCodeCompatibleEffort({ output_config: { effort: "max" } }, {}, base),
    "max"
  );
  assert.equal(resolveClaudeCodeCompatibleEffort({}, {}, "claude-opus-5"), "xhigh");
});

test("Opus 5.5 normalizes legacy thinking controls and preserves the chosen effort", () => {
  const body = { thinking: { type: "disabled" }, output_config: { effort: "low" } };
  const normalized = normalizeThinkingForModel(body, base);
  assert.equal("thinking" in normalized, false);
  assert.deepEqual(normalized.output_config, { effort: "low" });
  assert.deepEqual(
    normalizeClaudeAdaptiveThinking({ thinking: { type: "enabled", budget_tokens: 8000 } }, base),
    { thinking: { type: "adaptive" } }
  );
  assert.equal(shouldExposeNoThinkingAlias({ id: `claude/${base}`, owned_by: "claude" }), false);
});

test("Opus 5.5 discovery advertises all five efforts with inherited context limits", () => {
  const entry = { id: `claude/${base}`, owned_by: "claude", context_window: 1_000_000 };
  const catalog = appendClaudeEffortVariants([entry]);
  assert.deepEqual(
    catalog.map((model) => model.id),
    [entry.id, ...levels.map((level) => `${entry.id}-${level}`)]
  );
  assert.ok(catalog.every((model) => model.context_window === 1_000_000));
  assert.equal(shouldExposeClaudeEffortVariants({ id: `cu/${base}-max` }), false);
});

test("every native Opus 5.5 effort routes to the real base model without changing Cursor IDs", () => {
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
    assert.equal(
      applyClaudeEffortVariant({
        provider: "cursor",
        effectiveModel: `${base}-${effort}`,
        body: {},
        sourceFormat: "claude",
      }).effectiveModel,
      `${base}-${effort}`
    );
  }
});
