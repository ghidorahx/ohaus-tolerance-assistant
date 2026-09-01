import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [page, styles] = await Promise.all([
  readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
  readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
]);
const salesAssistant = await readFile(new URL("../app/SalesAssistant.tsx", import.meta.url), "utf8");

test("keeps the newest answer expanded above collapsible history", () => {
  assert.match(page, /grouped\.reverse\(\)/);
  assert.match(page, /Latest response/);
  assert.match(page, /<details className="history-item"/);
  assert.match(page, /Previous answers/);
});

test("places a sticky question bar above the responses", () => {
  const formIndex = page.indexOf('<form className="ask-form"');
  const responsesIndex = page.indexOf('<div className="message-list"');

  assert.ok(formIndex >= 0);
  assert.ok(responsesIndex > formIndex);
  assert.match(styles, /\.ask-form\s*\{[^}]*position:\s*sticky/s);
});

test("uses the requested neutral glass presentation", () => {
  assert.match(page, /"Service reference"/);
  assert.doesNotMatch(page, /"OHAUS service reference"/i);
  assert.match(page, /src="\.\/og\.png"/);
  assert.match(styles, /backdrop-filter:\s*blur/);
  assert.match(styles, /\.side-visual/);
  assert.match(styles, /aspect-ratio:\s*1730\s*\/\s*909/);
  assert.match(styles, /object-fit:\s*contain/);
});

test("provides a workbook-grounded Sales assistant with extended verified context", () => {
  assert.match(page, /<SalesAssistant/);
  assert.match(salesAssistant, /new URL\("api\/sales"/);
  assert.match(salesAssistant, /buildContext/);
  assert.match(salesAssistant, /verified turns/);
  assert.match(salesAssistant, /Verified catalog evidence/);
  assert.match(salesAssistant, /retry_after_seconds/);
  assert.match(salesAssistant, /Ready in \$\{rateLimitSeconds\}s/);
  assert.match(salesAssistant, /Sales pilot owner · T\. Delacruz/);
  assert.match(salesAssistant, /generated knowledge documents/);
  assert.match(styles, /\.sales-evidence-grid/);
  assert.match(styles, /\.sales-conversation/);
});

test("keeps the Sales surface concise and supports answer-specific follow-ups", () => {
  assert.doesNotMatch(salesAssistant, /Professional product assistant/);
  assert.doesNotMatch(salesAssistant, /Ask about any product detail in the catalog/);
  assert.match(salesAssistant, /Ask a follow-up about this answer/);
  assert.match(salesAssistant, /showFollowUpField/);
  assert.match(styles, /\.sales-inline-follow-up/);
});

test("renders clean Sales answer formatting with restrained OHAUS-red emphasis", () => {
  assert.match(salesAssistant, /function SalesAnswerContent/);
  assert.match(salesAssistant, /unordered-list/);
  assert.match(salesAssistant, /renderInlineAnswer/);
  assert.match(salesAssistant, /highlightPartNumbers/);
  assert.match(salesAssistant, /sales-part-number/);
  assert.match(salesAssistant, /<SalesAnswerContent value=\{answer\.answer\} partNumbers=\{answer\.materials\}/);
  assert.doesNotMatch(salesAssistant, /<p className="sales-answer-copy">\{answer\.answer\}<\/p>/);
  assert.match(styles, /\.sales-answer-copy strong\s*\{[^}]*color:\s*#c41230/s);
  assert.match(styles, /\.sales-answer-copy li::marker\s*\{[^}]*color:\s*#c41230/s);
});

test("renders every numbered Sales item on its own descriptive line", () => {
  assert.match(salesAssistant, /type AnswerItem/);
  assert.match(salesAssistant, /function SalesAnswerItems/);
  assert.match(salesAssistant, /<SalesAnswerItems items=\{answerItems\} partNumbers=\{answer\.materials\}/);
  assert.match(salesAssistant, /aria-label="Referenced items"/);
  assert.match(styles, /\.sales-answer-items\s*\{[^}]*display:\s*grid/s);
  assert.match(styles, /\.sales-answer-items > div > strong\s*\{[^}]*color:\s*#c41230/s);
});

test("keeps evidence and diagnostics inside one collapsed reference panel", () => {
  assert.match(salesAssistant, /<details className=\{`sales-reference-panel/);
  assert.match(salesAssistant, /Sources &amp; details/);
  assert.match(salesAssistant, /<div className="sales-reference-content">/);
  assert.match(styles, /\.sales-reference-panel\s*\{/);
  assert.match(styles, /\.sales-reference-panel\[open\]/);

  const answerStart = salesAssistant.indexOf('<SalesAnswerContent value={answer.answer}');
  const detailsStart = salesAssistant.indexOf('<details className={`sales-reference-panel', answerStart);
  const evidenceStart = salesAssistant.indexOf('<div className="sales-evidence">', answerStart);
  const footerStart = salesAssistant.indexOf('<div className="sales-answer-foot">', answerStart);
  const detailsEnd = salesAssistant.indexOf('</details>', detailsStart);
  assert.ok(answerStart >= 0 && detailsStart > answerStart);
  assert.ok(evidenceStart > detailsStart && evidenceStart < detailsEnd);
  assert.ok(footerStart > detailsStart && footerStart < detailsEnd);
});

test("makes the Sales product-knowledge rail collapsible and accessible", () => {
  assert.match(salesAssistant, /productKnowledgeCollapsed/);
  assert.match(salesAssistant, /aria-expanded=\{!productKnowledgeCollapsed\}/);
  assert.match(salesAssistant, /aria-controls="sales-product-knowledge-details"/);
  assert.match(salesAssistant, /sales-product-knowledge-collapsed/);
  assert.match(styles, /\.sales-workspace\.sales-rail-collapsed/);
  assert.match(styles, /\.sales-rail-body\[hidden\]/);
});

test("keeps every workspace mounted while switching tabs", () => {
  assert.match(page, /className="mode-surface tolerance-mode-surface" hidden=\{mode !== "tolerance"\}/);
  assert.match(page, /className="mode-surface sales-mode-surface" hidden=\{!isSalesMode\}/);
  assert.match(page, /className="mode-surface compatibility-mode-surface" hidden=\{!isCompatibilityMode\}/);
  assert.doesNotMatch(page, /\{isSalesMode && <SalesAssistant/);
  assert.match(styles, /\.mode-surface\[hidden\]\s*\{\s*display:\s*none\s*!important;/);

  const switchMode = page.match(/function switchMode[\s\S]*?\n {2}\}/)?.[0] ?? "";
  assert.doesNotMatch(switchMode, /setInput\(""\)/);
});
