import test from "node:test";
import assert from "node:assert/strict";
import { googleAnswerLines, safeGoogleSourceUrl } from "../lib/google-direct-format.mjs";

const sources = [{ title: "OHAUS", url: "https://us.ohaus.com/manual" }];

test("direct answer formatting keeps UTF-16 citations aligned while stripping markdown", () => {
  const answer = "**🔎 Part 12345678** — foot.\n- [Official manual](https://example.com)";
  const firstEnd = answer.indexOf("\n");
  const lines = googleAnswerLines(answer, sources, [
    { start: 0, end: firstEnd, source_index: 0 },
    { start: firstEnd + 1, end: answer.length, source_index: 0 },
  ]);
  assert.equal(lines[0].text, "🔎 Part 12345678 — foot.");
  assert.deepEqual(lines[0].citations, [{ offset: lines[0].text.length, source_index: 0 }]);
  assert.equal(lines[1].kind, "unordered-item");
  assert.equal(lines[1].text, "Official manual");
  assert.equal(lines[1].citations[0].offset, lines[1].text.length);
});

test("direct answer formatting rejects unsafe, invalid and duplicate citations", () => {
  const citation = { start: 0, end: 4, source_index: 0 };
  const lines = googleAnswerLines("Fact", [...sources, { url: "javascript:alert(1)" }], [
    citation, citation, null, { ...citation, end: 5 }, { ...citation, start: -1 },
    { ...citation, source_index: 1 }, { ...citation, source_index: 99 },
  ]);
  assert.deepEqual(lines[0].citations, [{ offset: 4, source_index: 0 }]);
  assert.equal(safeGoogleSourceUrl("javascript:alert(1)"), null);
  assert.equal(safeGoogleSourceUrl("https://secret:password@example.com"), null);
  assert.equal(safeGoogleSourceUrl("/relative"), null);
});

test("direct answer citations stay beside their own sentence rather than at the answer end", () => {
  const answer = "**First fact.** Second fact.\r\nMore detail.";
  const firstEnd = answer.indexOf(" Second");
  const lines = googleAnswerLines(answer, sources, [{ start: 0, end: firstEnd, source_index: 0 }]);
  assert.equal(lines[0].text, "First fact. Second fact.");
  assert.equal(lines[0].citations[0].offset, "First fact.".length);
  assert.equal(lines[1].text, "More detail.");
  assert.deepEqual(lines[1].citations, []);
});

test("direct answer formatting preserves line hierarchy and citations before newlines", () => {
  const answer = "# Details\n\n1. `123456` — foot.\n\nNext line.";
  const end = answer.indexOf("Next");
  const lines = googleAnswerLines(answer, sources, [{ start: 11, end, source_index: 0 }]);
  assert.deepEqual(lines.map(({ kind }) => kind), ["heading", "ordered-item", "paragraph"]);
  assert.equal(lines[1].text, "123456 — foot.");
  assert.equal(lines[1].citations[0].offset, lines[1].text.length);
});
