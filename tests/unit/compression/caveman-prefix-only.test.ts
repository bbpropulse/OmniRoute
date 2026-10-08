import test from "node:test";
import assert from "node:assert/strict";
import { cavemanCompress } from "../../../open-sse/services/compression/caveman.ts";

function compress(text: string) {
  const body = { messages: [{ role: "user", content: text }] };
  const result = cavemanCompress(body, {
    enabled: true,
    intensity: "lite",
    prefixOnly: true,
    compressRoles: ["user"],
  });
  return (result.body.messages as typeof body.messages)[0].content;
}

for (const text of [
  "I think that the migration probably requires a rollback, but do not run it without approval.",
  "Provide a detailed explanation of the migration risks and explain in detail how to verify every step.",
  "Eu acho que talvez a migração precise de rollback, mas não execute nada sem autorização.",
  "Verifique se você pode acessar o banco, preserve todos os dados e explique cada etapa detalhadamente.",
  "Do not remove the word please from this instruction, and keep every validation check enabled.",
]) {
  test(`prefix-only preserves the complete technical request: ${text.slice(0, 30)}`, () =>
    assert.equal(compress(text), text));
}

test("prefix-only removes leading Portuguese courtesy without rewriting uncertainty, conditions or code", () => {
  const remainder =
    "eu acho que talvez seja necessário rollback; explique detalhadamente antes de executar.\n```js\nconst amount = 42;\n```";
  assert.equal(compress(`Por favor, ${remainder}`), remainder);
});

test("prefix-only removes leading English courtesy and preserves the remaining bytes", () => {
  const remainder =
    "provide a detailed explanation; the migration probably requires rollback, but do not run it.";
  assert.equal(compress(`Please ${remainder}`), remainder);
});
