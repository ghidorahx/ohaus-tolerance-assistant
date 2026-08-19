import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

test("builds a self-contained GitHub Pages application", async () => {
  const page = new URL("../pages-dist/index.html", import.meta.url);
  const data = new URL("../pages-dist/data/ohaus-knowledge.json", import.meta.url);
  await Promise.all([access(page), access(data)]);

  const [html, knowledge] = await Promise.all([
    readFile(page, "utf8"),
    readFile(data, "utf8").then(JSON.parse),
  ]);

  assert.match(html, /OHAUS Tolerance Assistant/);
  assert.match(html, /\/ohaus-tolerance-assistant\/assets\//);
  assert.equal(knowledge.current.length + knowledge.legacy.length, 746);
});
