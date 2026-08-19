import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { answerQuestion } from "../lib/answer-engine.mjs";

const knowledge = JSON.parse(
  await readFile(new URL("../public/data/ohaus-knowledge.json", import.meta.url), "utf8"),
);

const cases = [
  ["What is the tolerance for STX622?", "model", "±0.03 g (±3d)"],
  ["What is the OCL for RC31P3?", "model", "±0.2 g (±2d)"],
  ["What is the repeatability for STX622?", "model", "±0.01 g (±1d)"],
  ["What is the linearity for STX622?", "model", "±0.02 g (±2d)"],
  ["What is the readability for STX622?", "model", "0.01 g"],
  ["What is the capacity for STX622?", "model", "620 g"],
  ["Which weight class does R71MHD3 use?", "model", "ASTM Class 2 / OIML F1"],
  ["What is the temperature tolerance for MB32?", "temperature", "±4 °C"],
  ["What is tolerance vs uncertainty?", "guidance", "manufacturing limit"],
  ["What is MPE?", "guidance", "maximum permissible error"],
];

for (const [question, kind, expected] of cases) {
  test(question, () => {
    const answer = answerQuestion(question, knowledge);
    assert.equal(answer.kind, kind);
    assert.match(answer.text, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
    if (answer.record) assert.ok(answer.source?.page);
  });
}

test("requires a current/legacy choice for a duplicated model", () => {
  const ambiguous = answerQuestion("What is the tolerance for EX10201?", knowledge);
  assert.equal(ambiguous.kind, "ambiguous");
  assert.equal(ambiguous.options.length, 2);

  const current = answerQuestion("What is the tolerance for current EX10201?", knowledge);
  assert.equal(current.kind, "model");
  assert.equal(current.record.lifecycle, "current");
});

test("uses exact model boundaries instead of partial matches", () => {
  const answer = answerQuestion("What is the tolerance for STX62?", knowledge);
  assert.equal(answer.kind, "not-found");
});
