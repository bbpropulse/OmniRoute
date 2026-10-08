import { AsyncLocalStorage } from "node:async_hooks";
import assert from "node:assert/strict";
import test from "node:test";

import {
  captureCurrentProviderBody,
  runWithCapture,
  type Capture,
  type ProviderRequestPrepared,
} from "../../open-sse/utils/providerRequestLogging.ts";

const url = "https://provider.example/v1/messages";
const bodyString = JSON.stringify({ model: "claude-sonnet-5-5", messages: [] });

function makeCapture() {
  const requests: ProviderRequestPrepared[] = [];
  const capture: Capture = {
    capture(request) {
      requests.push(request);
    },
    body(fallback) {
      return requests.at(-1)?.body ?? fallback;
    },
    latest() {
      return requests.at(-1) ?? null;
    },
  };
  return { capture, requests };
}

for (const outcome of ["success", "rejection", "synchronous throw"] as const) {
  test(`inherited async resources release the request capture after ${outcome}`, async () => {
    const { capture, requests } = makeCapture();
    let resume = AsyncLocalStorage.snapshot();
    let inheritedStore: unknown;
    const stateKey = Symbol.for("omniroute.providerRequestCapture.state");
    const scopedGlobal = globalThis as typeof globalThis & {
      [stateKey]?: { context: AsyncLocalStorage<unknown> };
    };
    const dispatch = () => {
      resume = AsyncLocalStorage.snapshot();
      inheritedStore = scopedGlobal[stateKey]?.context.getStore();
      if (outcome === "synchronous throw") throw new Error("dispatch failed");
      return (async () => {
        await captureCurrentProviderBody(url, {}, bodyString);
        if (outcome === "rejection") throw new Error("dispatch failed");
      })();
    };

    if (outcome === "success") {
      await runWithCapture(capture, dispatch);
    } else {
      await assert.rejects(async () => runWithCapture(capture, dispatch), /dispatch failed/);
    }

    const before = requests.length;
    await resume(() => captureCurrentProviderBody(url, {}, '{"model":"background"}'));
    assert.equal(requests.length, before, "settled dispatch must not capture background work");
    assert.deepEqual(
      inheritedStore,
      { capture: null },
      "async resources retain only an empty holder"
    );
    if (outcome === "success") {
      assert.equal(capture.latest()?.bodyString, bodyString, "response handling keeps its capture");
    }
  });
}

test("settling an inner dispatch leaves the outer request capture active", async () => {
  const outer = makeCapture();
  const inner = makeCapture();
  await runWithCapture(outer.capture, async () => {
    await runWithCapture(inner.capture, () => captureCurrentProviderBody(url, {}, bodyString));
    await captureCurrentProviderBody(url, {}, bodyString);
  });
  assert.equal(inner.requests.length, 1);
  assert.equal(outer.requests.length, 1);
});

test("an identical prepared fetch does not parse another copy of the payload", async () => {
  const originalFetch = globalThis.fetch;
  const originalParse = JSON.parse;
  const { capture } = makeCapture();
  let parseCount = 0;
  JSON.parse = (text, reviver) => {
    if (text === bodyString) parseCount++;
    return originalParse(text, reviver);
  };
  globalThis.fetch = async () => new Response("OK");
  try {
    await runWithCapture(capture, async () => {
      await capture.capture({ url, headers: {}, body: { messages: [] }, bodyString });
      await fetch(url, { method: "POST", body: bodyString });
    });
    assert.equal(parseCount, 0);
  } finally {
    JSON.parse = originalParse;
    globalThis.fetch = originalFetch;
  }
});

test("body capture outside a dispatch does not parse the payload", async () => {
  const originalParse = JSON.parse;
  let parseCount = 0;
  JSON.parse = (text, reviver) => {
    if (text === bodyString) parseCount++;
    return originalParse(text, reviver);
  };
  try {
    await captureCurrentProviderBody(url, {}, bodyString);
    assert.equal(parseCount, 0);
  } finally {
    JSON.parse = originalParse;
  }
});
