import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const originalDataDir = process.env.DATA_DIR;
const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-sonnet55-sampling-"));
process.env.DATA_DIR = testDataDir;

const core = await import("../../src/lib/db/core.ts");
const { setParamFilterConfig, deleteParamFilterConfig } =
  await import("../../src/lib/db/paramFilters.ts");
const { stripUnsupportedParams } = await import("../../open-sse/translator/paramSupport.ts");
const { enforceThinkingTemperature } =
  await import("../../open-sse/services/claudeCodeConstraints.ts");
const { applyProviderRequestDefaults } =
  await import("../../open-sse/services/providerRequestDefaults.ts");
const { BaseExecutor } = await import("../../open-sse/executors/base.ts");
const { DefaultExecutor } = await import("../../open-sse/executors/default.ts");

type JsonRecord = Record<string, unknown>;
const samplingKeys = ["temperature", "top_p", "top_k"] as const;
const models = [
  "claude-sonnet-5-5",
  "anthropic/claude-sonnet-5-5",
  "claude-sonnet-5-5-high",
  "anthropic/claude-sonnet-5-5-medium",
  "gateway/anthropic/claude-sonnet-5-5-20261029",
];
const controls = ["claude-sonnet-5", "claude-sonnet-5-50", "claude-sonnet-4-6", "gpt-4.1"];

function sampling(temperature = 0.7): JsonRecord {
  return { temperature, top_p: 0.9, top_k: 40 };
}

function assertSamplingOmitted(body: JsonRecord, context: string): void {
  for (const key of samplingKeys) {
    assert.equal(Object.hasOwn(body, key), false, `${context}: ${key} must be absent`);
  }
}

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(testDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

test("Sonnet 5.5 filters omit all sampling keys for bare, prefixed and suffixed models", () => {
  for (const model of models) {
    for (const temperature of [0, 1, 0.7]) {
      const body = { model, ...sampling(temperature), max_tokens: 64 };
      assert.equal(stripUnsupportedParams("openrouter", model, body), body);
      assertSamplingOmitted(body, model);
      assert.equal(body.model, model);
      assert.equal(body.max_tokens, 64);
    }
  }
});

test("Sonnet 5.5 sampling cannot be restored by provider or model allowlists", () => {
  const model = "anthropic/claude-sonnet-5-5-medium";
  try {
    for (const modelLevel of [false, true]) {
      setParamFilterConfig("openrouter", {
        block: [],
        allow: modelLevel ? [] : [...samplingKeys],
        ...(modelLevel ? { models: { [model]: { allow: [...samplingKeys] } } } : {}),
        autoLearn: false,
      });
      const body = { model, ...sampling(0), max_tokens: 64 };
      stripUnsupportedParams("openrouter", model, body);
      assertSamplingOmitted(body, modelLevel ? "model allowlist" : "provider allowlist");
      assert.equal(body.max_tokens, 64);
    }
  } finally {
    deleteParamFilterConfig("openrouter");
  }
});

test("Sonnet 5.5 thinking constraints never inject or retain sampling parameters", () => {
  for (const model of models) {
    for (const type of ["adaptive", "enabled"]) {
      const body = { model, ...sampling(), thinking: { type, budget_tokens: 1024 } };
      enforceThinkingTemperature(body);
      assertSamplingOmitted(body, `${model}/${type}`);
      assert.deepEqual(body.thinking, { type, budget_tokens: 1024 });

      const withoutSampling = { model, thinking: { type } };
      enforceThinkingTemperature(withoutSampling);
      assertSamplingOmitted(withoutSampling, `${model}/${type}/no sampling supplied`);
    }
  }
});

test("other model families retain their existing sampling behavior", () => {
  for (const model of controls) {
    const body = { model, ...sampling(), max_tokens: 64 };
    const original = structuredClone(body);
    stripUnsupportedParams("openrouter", model, body);
    enforceThinkingTemperature(body);
    assert.deepEqual(body, original, model);
  }
  const legacyThinking = {
    model: "claude-sonnet-5",
    ...sampling(),
    thinking: { type: "adaptive" },
  };
  enforceThinkingTemperature(legacyThinking);
  assert.equal(legacyThinking.temperature, 1);
  assert.equal(Object.hasOwn(legacyThinking, "top_p"), false);
  assert.equal(legacyThinking.top_k, 40);
});

// Simulate an executor that reapplies provider defaults after the handler filters.
// The real BaseExecutor dispatch must still enforce the final serialized payload.
class LateDefaultsExecutor extends BaseExecutor {
  constructor(provider: string) {
    super(provider, {
      baseUrls: ["https://api.anthropic.com/v1/messages"],
      requestDefaults: { temperature: 0.7 },
    });
  }

  needsRefresh(): boolean {
    return false;
  }

  transformRequest(model: string, body: JsonRecord, stream: boolean): unknown {
    return applyProviderRequestDefaults({ ...body, model, stream }, this.config.requestDefaults);
  }
}

async function captureDispatch(
  executor: InstanceType<typeof BaseExecutor>,
  model: string,
  body: JsonRecord,
  stream: boolean
): Promise<JsonRecord> {
  const originalFetch = globalThis.fetch;
  const originalBody = structuredClone(body);
  let captured: JsonRecord | undefined;
  globalThis.fetch = async (_url, init = {}) => {
    captured = JSON.parse(String(init.body)) as JsonRecord;
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  try {
    await executor.execute({ model, body, stream, credentials: { apiKey: "test-sampling-key" } });
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.ok(captured, "request must reach the fetch boundary");
  assert.deepEqual(body, originalBody, "execute must preserve the caller's original body");
  return captured;
}

test("streaming and JSON dispatch omit sampling even after defaults and thinking", async () => {
  const cases = [
    { model: models[0], temperature: 0 },
    { model: models[1], temperature: 0.7, thinking: { type: "adaptive" } },
    { model: models[2], temperature: 1, thinking: { type: "enabled", budget_tokens: 1024 } },
    { model: models[3], thinking: { type: "adaptive" } },
  ];
  for (const stream of [false, true]) {
    for (const provider of ["claude", "openrouter"]) {
      for (const input of cases) {
        const body = {
          model: input.model,
          messages: [{ role: "user", content: "hello" }],
          max_tokens: 64,
          top_p: 0.9,
          top_k: 40,
          ...(input.temperature === undefined ? {} : { temperature: input.temperature }),
          ...(input.thinking ? { thinking: input.thinking } : {}),
        };
        const sent = await captureDispatch(
          new LateDefaultsExecutor(provider),
          input.model,
          body,
          stream
        );
        assertSamplingOmitted(sent, `${provider}/${input.model}/stream=${stream}`);
        assert.equal(sent.model, input.model);
        assert.equal(sent.stream, stream);
        assert.equal(sent.max_tokens, 64);
      }
    }
  }
});

test("DefaultExecutor applies the Sonnet 5.5 rule while preserving other models on the wire", async () => {
  for (const stream of [false, true]) {
    for (const model of [models[3], ...controls]) {
      const executor = new DefaultExecutor("openrouter");
      executor.config = { ...executor.config, requestDefaults: { temperature: 0.7 } };
      const body = { model, messages: [{ role: "user", content: "hello" }], top_p: 0.9, top_k: 40 };
      const sent = await captureDispatch(executor, model, body, stream);
      if (model === models[3]) assertSamplingOmitted(sent, `DefaultExecutor/stream=${stream}`);
      else {
        for (const key of samplingKeys) assert.equal(sent[key], sampling()[key], `${model}/${key}`);
      }
    }
  }
});
