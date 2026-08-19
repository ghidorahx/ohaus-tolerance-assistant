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

test("uses the requested neutral glass presentation", () => {
  assert.match(page, />Service reference</);
  assert.doesNotMatch(page, />OHAUS service reference</i);
  assert.match(page, /src="\.\/og\.png"/);
  assert.match(styles, /backdrop-filter:\s*blur/);
  assert.match(styles, /\.hero-visual/);
});
