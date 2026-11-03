import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omr-memory-pt-budget-"));
process.env.DATA_DIR = dataDir;
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";
process.env.VECTOR_STORE_DISABLE_VEC = "true";

const { resetDbInstance, getDbInstance } = await import("../../src/lib/db/core.ts");
const { extractFactsFromText } = await import("../../src/lib/memory/extraction.ts");
const { retrieveMemories, estimateTokens } = await import("../../src/lib/memory/retrieval.ts");

test.after(() => {
  resetDbInstance();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("Portuguese memory extraction recognizes first-person preferences, decisions and habits", () => {
  const examples = [
    ["Eu prefiro respostas em português brasileiro.", "preference"],
    ["Prefiro usar apenas modelos Claude no Claude Desktop.", "preference"],
    ["Eu gosto de exemplos práticos!", "preference"],
    ["Eu decidi usar PostgreSQL neste projeto.", "decision"],
    ["Escolhi TypeScript para o backend.", "decision"],
    ["Vou usar testes de integração.", "decision"],
    ["Eu sempre reviso as alterações antes de publicar.", "pattern"],
    ["Eu costumo escrever os testes primeiro.", "pattern"],
  ];
  for (const [text, category] of examples) {
    const facts = extractFactsFromText(text);
    assert.equal(facts.length, 1, text);
    assert.equal(facts[0].category, category, text);
    assert.equal(facts[0].content, text.slice(0, -1), text);
  }
});

test("Portuguese extraction preserves negation and does not merge opposite preferences", () => {
  const facts = extractFactsFromText(
    "Eu gosto de notificações. Eu não gosto de notificações. Eu nunca publico sem testar."
  );
  assert.equal(facts.length, 3);
  assert.ok(facts.some((fact) => fact.content === "Eu não gosto de notificações"));
  assert.ok(facts.some((fact) => fact.content === "Eu nunca publico sem testar"));
  assert.equal(new Set(facts.map((fact) => fact.key)).size, 3);
  assert.deepEqual(extractFactsFromText("Ela gosta de Python. O servidor está ativo."), []);
});

test("Portuguese extraction deduplicates and caps long facts", () => {
  assert.equal(
    extractFactsFromText("Prefiro respostas curtas. Prefiro respostas curtas.").length,
    1
  );
  const facts = extractFactsFromText(`Eu prefiro ${"exemplos claros ".repeat(100)}.`);
  assert.equal(facts.length, 1);
  assert.ok(facts[0].content.length <= 500);
});

test("memory retrieval honors the supported 16k budget and retains API-key isolation", async () => {
  const db = getDbInstance();
  const now = new Date().toISOString();
  const insert = db.prepare(
    "INSERT INTO memories (id, api_key_id, session_id, type, key, content, metadata, created_at, updated_at, expires_at) VALUES (?, ?, '', 'factual', ?, ?, '{}', ?, ?, NULL)"
  );
  for (let i = 0; i < 20; i++) {
    insert.run(`budget-${i}`, "budget-owner", `fact-${i}`, "a".repeat(4000), now, now);
  }
  insert.run(
    "other-owner",
    "other-key",
    "private-fact",
    "Never include another key's memory",
    now,
    now
  );
  for (const [budget, expected] of [
    [16000, 16],
    [8000, 8],
    [1000000, 16],
  ]) {
    const memories = await retrieveMemories("budget-owner", {
      enabled: true,
      retrievalStrategy: "exact",
      maxTokens: budget,
      retentionDays: 365,
    });
    assert.equal(memories.length, expected, `budget=${budget}`);
    assert.ok(memories.every((memory) => memory.apiKeyId === "budget-owner"));
    assert.equal(
      memories.reduce((sum, memory) => sum + estimateTokens(memory.content), 0),
      expected * 1000
    );
  }
});
