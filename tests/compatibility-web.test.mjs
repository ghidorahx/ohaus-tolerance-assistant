import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [dataText, component, page] = await Promise.all([
  readFile(new URL("../public/data/portable-balance-web.json", import.meta.url), "utf8"),
  readFile(new URL("../app/CompatibilityWeb.tsx", import.meta.url), "utf8"),
  readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
]);
const data = JSON.parse(dataText);

test("builds the portable web from the exact MMDF workbook", () => {
  assert.equal(data.metadata.sourceFile, "MMMDF_EN_US_20260605_AI_Organized 2.xlsx");
  assert.equal(data.metadata.sourceSha256, "5651c886837bf7b6817d829273d3c9a608658cd107798a9d206d01ad404950bb");
  assert.equal(data.metadata.selectionRule, "Raw_Data: Parent Family Name = Portable Balances");
});

test("limits the compatibility graph to every portable balance and related part", () => {
  const models = data.nodes.filter((node) => node.kind === "model");
  const parts = data.nodes.filter((node) => node.kind === "part");
  const series = data.nodes.filter((node) => node.kind === "series");
  assert.equal(models.length, 80);
  assert.equal(series.length, 7);
  assert.equal(parts.length, 98);
  assert.equal(data.metadata.resolvedParts, 91);
  assert.equal(data.metadata.unresolvedParts, 7);
  assert.deepEqual(new Set(models.map((node) => node.parentId)), new Set(series.map((node) => node.id)));
  assert.ok(data.nodes.every((node) => !/analytical|bench scale|moisture analyzer/i.test(node.label)));
});

test("restores the original top-level product families as placeholders", () => {
  const families = data.nodes.filter((node) => node.kind === "family");
  assert.deepEqual(
    families.map((node) => node.label),
    ["Balances & Scales", "Instruments", "Laboratory Equipment", "Weights", "Accessories & Printers"],
  );
  assert.ok(families.filter((node) => node.id !== "balances-scales").every((node) => node.parentId === "ohaus" && node.verified === false));
  assert.ok(families.filter((node) => node.id !== "balances-scales").every((family) => !data.nodes.some((node) => node.parentId === family.id)));
});

test("preserves all workbook accessory and spare-part relationships", () => {
  assert.equal(data.links.length, 1820);
  assert.equal(data.links.filter((link) => link.relationType === "accessory").length, 794);
  assert.equal(data.links.filter((link) => link.relationType === "spare_part").length, 1026);
  assert.equal(new Set(data.links.map((link) => `${link.source}|${link.target}|${link.relationType}`)).size, data.links.length);
  assert.ok(data.links.every((link) => link.source.startsWith("model:") && link.target.startsWith("part:")));
});

test("supports concise exploration without hiding catalog coverage", () => {
  assert.match(component, /Find model, item number, or description/);
  assert.match(component, /`Accessories \$\{relationshipCounts\.accessory\}`/);
  assert.match(component, /`Spare parts \$\{relationshipCounts\.spare_part\}`/);
  assert.match(component, /pageSize = 12/);
  assert.match(component, /const initialPath = \["ohaus"\]/);
  assert.match(component, /Center on OHAUS/);
  assert.match(component, /<details className="web-relationship-details">/);
  assert.match(component, /Item \{selectedNode\.materialNumber\}/);
  assert.match(component, /Raw_Data row \{selectedNode\.sourceRow\}/);
  assert.match(page, /<PortableCompatibilityWeb/);
  assert.doesNotMatch(page, /const networkNodes/);
});
