import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omr-strict-memory-"));
process.env.DATA_DIR = dataDir;
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";
process.env.VECTOR_STORE_DISABLE_VEC = "true";
const core = await import("../../src/lib/db/core.ts");
const { retrieveMemories, retrievePreview, estimateTokens } =
  await import("../../src/lib/memory/retrieval.ts");

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function seed(owner: string, includeSmall: boolean) {
  const db = core.getDbInstance();
  const insert = db.prepare(
    "INSERT INTO memories (id, api_key_id, session_id, type, key, content, metadata, created_at, updated_at) VALUES (?, ?, '', 'factual', ?, ?, '{}', ?, ?)"
  );
  insert.run(
    `${owner}-large`,
    owner,
    "scopefix",
    "scopefix ".repeat(100),
    "2026-10-08T12:00:00Z",
    "2026-10-08T12:00:00Z"
  );
  if (includeSmall)
    insert.run(
      `${owner}-small`,
      owner,
      "scopefix",
      "scopefix",
      "2026-10-08T11:00:00Z",
      "2026-10-08T11:00:00Z"
    );
  insert.run(
    `${owner}-foreign`,
    `${owner}-other`,
    "scopefix",
    "scopefix",
    "2026-10-08T13:00:00Z",
    "2026-10-08T13:00:00Z"
  );
  db.prepare("UPDATE memories SET memory_id = rowid WHERE api_key_id IN (?, ?)").run(
    owner,
    `${owner}-other`
  );
}

for (const strategy of ["exact", "semantic", "hybrid"] as const) {
  for (const includeSmall of [false, true]) {
    test(`${strategy}: oversized facts never exceed the budget; whole smaller facts remain eligible (${includeSmall})`, async () => {
      const owner = `live-${strategy}-${includeSmall}`;
      seed(owner, includeSmall);
      const memories = await retrieveMemories(owner, {
        retrievalStrategy: strategy,
        query: "scopefix",
        maxTokens: 10,
        retentionDays: 365,
      });
      assert.deepEqual(
        memories.map((m) => m.id),
        includeSmall ? [`${owner}-small`] : []
      );
      assert.ok(memories.reduce((n, m) => n + estimateTokens(m.content), 0) <= 10);
    });

    test(`${strategy}: preview applies the same strict budget and tenant isolation (${includeSmall})`, async () => {
      const owner = `preview-${strategy}-${includeSmall}`;
      seed(owner, includeSmall);
      const bundle = await retrievePreview(owner, "scopefix", {
        strategy,
        maxTokens: 10,
        limit: 20,
      });
      assert.deepEqual(
        bundle.items.map((m) => m.memory.id),
        includeSmall ? [`${owner}-small`] : []
      );
      assert.ok(bundle.totalTokens <= bundle.budgetMaxTokens);
    });
  }
}
