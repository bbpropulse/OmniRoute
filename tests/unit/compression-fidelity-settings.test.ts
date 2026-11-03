import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omr-fidelity-settings-"));
process.env.DATA_DIR = dataDir;
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";
const { compressionSettingsUpdateSchema } =
  await import("../../src/shared/validation/compressionConfigSchemas.ts");
const { updateCompressionSettings, getCompressionSettings } =
  await import("../../src/lib/db/compression.ts");
const { resetDbInstance } = await import("../../src/lib/db/core.ts");
test.after(() => {
  resetDbInstance();
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("production settings accept and retain a strict fidelity gate", async () => {
  const gate = {
    enabled: true,
    minTokenSurvivalPercent: 100,
    minJsonKeyPercent: 100,
    checkNumericIntegrity: true,
    checkDiffHunks: true,
  };
  assert.equal(compressionSettingsUpdateSchema.safeParse({ fidelityGate: gate }).success, true);
  assert.deepEqual((await updateCompressionSettings({ fidelityGate: gate })).fidelityGate, gate);
  assert.deepEqual((await getCompressionSettings()).fidelityGate, gate);
  assert.equal(
    (await updateCompressionSettings({ fidelityGate: { enabled: false } })).fidelityGate?.enabled,
    false
  );
});

test("production fidelity thresholds reject invalid configuration", () => {
  for (const gate of [
    { enabled: true, minTokenSurvivalPercent: 101 },
    { enabled: true, minJsonKeyPercent: -1 },
    { enabled: "true" },
    { enabled: true, checkNumericIntegrity: "true" },
  ]) {
    assert.equal(compressionSettingsUpdateSchema.safeParse({ fidelityGate: gate }).success, false);
  }
});

test("Caveman prefix-only survives production validation and settings readback", async () => {
  const settings = { cavemanConfig: { enabled: true, prefixOnly: true } };
  const parsed = compressionSettingsUpdateSchema.parse(settings);
  assert.equal(parsed.cavemanConfig?.prefixOnly, true);
  assert.equal((await updateCompressionSettings(parsed)).cavemanConfig?.prefixOnly, true);
  assert.equal((await getCompressionSettings()).cavemanConfig?.prefixOnly, true);
  assert.equal(
    compressionSettingsUpdateSchema.safeParse({ cavemanConfig: { prefixOnly: "true" } }).success,
    false
  );
});

test("fidelity settings retain fractional percentage thresholds", async () => {
  const fidelityGate = {
    enabled: true,
    minTokenSurvivalPercent: 99.5,
    minJsonKeyPercent: 97.25,
    checkNumericIntegrity: true,
    checkDiffHunks: true,
  };
  const parsed = compressionSettingsUpdateSchema.parse({ fidelityGate });
  assert.deepEqual((await updateCompressionSettings(parsed)).fidelityGate, fidelityGate);
});
