import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [page, styles] = await Promise.all([
  readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
  readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
]);

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
  assert.match(page, />Service reference</);
  assert.doesNotMatch(page, />OHAUS service reference</i);
  assert.match(page, /src="\.\/og\.png"/);
  assert.match(styles, /backdrop-filter:\s*blur/);
  assert.match(styles, /\.side-visual/);
  assert.match(styles, /aspect-ratio:\s*1730\s*\/\s*909/);
  assert.match(styles, /object-fit:\s*contain/);
});
