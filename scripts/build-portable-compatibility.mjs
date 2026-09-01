import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = path.resolve(
  process.argv[2] ?? path.join(appRoot, "MMMDF_EN_US_20260605_AI_Organized 2.xlsx"),
);
const outputPath = path.resolve(
  process.argv[3] ?? path.join(appRoot, "public/data/portable-balance-web.json"),
);

const relationshipColumns = [
  ["Relationship / Accessories", "accessory", "Accessory"],
  ["Relationship / Spare Parts", "spare_part", "Spare part"],
];

function unzipEntry(entry) {
  const result = spawnSync("unzip", ["-p", sourcePath, entry], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || `Unable to read ${entry}`);
  return result.stdout;
}

function decodeXml(value = "") {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

function clean(value) {
  return String(value ?? "").replaceAll("\u00a0", " ").replace(/\s+/g, " ").trim();
}

function columnIndex(reference) {
  const letters = reference.match(/^[A-Z]+/)?.[0] ?? "A";
  let value = 0;
  for (const letter of letters) value = value * 26 + letter.charCodeAt(0) - 64;
  return value - 1;
}

function slug(value) {
  return clean(value)
    .normalize("NFKD")
    .replace(/[™®©]/g, "")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

function splitRelationship(value) {
  return [...new Set(clean(value).split(/[;,|]/).map(clean).filter(Boolean))];
}

function parseRows() {
  const sharedXml = unzipEntry("xl/sharedStrings.xml");
  const sharedStrings = [...sharedXml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((match) =>
    decodeXml([...match[1].matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((part) => part[1]).join("")),
  );
  const sheetXml = unzipEntry("xl/worksheets/sheet2.xml");
  const rows = [];
  for (const rowMatch of sheetXml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/g)) {
    const row = [];
    const sourceRow = Number(rowMatch[1].match(/\br="(\d+)"/)?.[1] ?? rows.length + 1);
    for (const cellMatch of rowMatch[2].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
      const attrs = cellMatch[1];
      const body = cellMatch[2];
      const reference = attrs.match(/\br="([A-Z]+\d+)"/)?.[1];
      if (!reference) continue;
      const type = attrs.match(/\bt="([^"]+)"/)?.[1];
      const raw = body.match(/<v>([\s\S]*?)<\/v>/)?.[1] ?? "";
      const inline = [...body.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((part) => part[1]).join("");
      row[columnIndex(reference)] = clean(type === "s" ? sharedStrings[Number(raw)] ?? "" : decodeXml(inline || raw));
    }
    rows.push({ sourceRow, values: row });
  }
  return rows;
}

const rows = parseRows();
const headerRowIndex = rows.findIndex(({ values }) => values.includes("Material Number") && values.includes("Parent Family Name"));
if (headerRowIndex < 0) throw new Error("Could not locate the Raw_Data header row.");

const headers = rows[headerRowIndex].values;
const headerIndex = new Map(Array.from(headers.entries()).map(([index, header]) => [header, index]));
const valueAt = (row, header) => clean(row.values[headerIndex.get(header)]);
const catalogRows = rows.slice(headerRowIndex + 1).filter((row) => valueAt(row, "Material Number"));
const materialLookup = new Map(catalogRows.map((row) => [valueAt(row, "Material Number"), row]));
const portableRows = catalogRows.filter((row) => valueAt(row, "Parent Family Name") === "Portable Balances");

if (!portableRows.length) throw new Error("No rows matched Parent Family Name = Portable Balances.");

const familyNames = [...new Set(portableRows.map((row) => valueAt(row, "Family Name")))].sort();
const familyIds = new Map(familyNames.map((family) => [family, `series:${slug(family)}`]));
const nodes = [
  {
    id: "ohaus",
    label: "OHAUS",
    kind: "root",
    detail: "Workbook-grounded portable weighing compatibility.",
    parentId: null,
    verified: true,
  },
  {
    id: "balances-scales",
    label: "Balances & Scales",
    kind: "family",
    detail: "This release is intentionally limited to portable balances.",
    parentId: "ohaus",
    verified: true,
  },
  {
    id: "portable-balances",
    label: "Portable Balances",
    kind: "category",
    detail: `${portableRows.length} portable balances across ${familyNames.length} workbook families.`,
    parentId: "balances-scales",
    verified: true,
  },
  ...familyNames.map((family) => {
    const familyRows = portableRows.filter((row) => valueAt(row, "Family Name") === family);
    return {
      id: familyIds.get(family),
      label: family,
      kind: "series",
      detail: valueAt(familyRows[0], "Family Description") || `${familyRows.length} portable balance models.`,
      parentId: "portable-balances",
      family,
      modelCount: familyRows.length,
      verified: true,
    };
  }),
];

const links = [];
const referencedMaterials = new Set();
const relationSeen = new Set();
const productRelationCounts = new Map();

for (const row of portableRows) {
  const materialNumber = valueAt(row, "Material Number");
  const model = valueAt(row, "Trade Name") || materialNumber;
  const counts = { accessory: 0, spare_part: 0 };
  for (const [sourceField, relationType, label] of relationshipColumns) {
    for (const relatedMaterial of splitRelationship(valueAt(row, sourceField))) {
      const key = `${materialNumber}|${relatedMaterial}|${relationType}`;
      if (relationSeen.has(key)) continue;
      relationSeen.add(key);
      referencedMaterials.add(relatedMaterial);
      counts[relationType] += 1;
      links.push({
        source: `model:${materialNumber}`,
        target: `part:${relatedMaterial}`,
        state: "compatible",
        relationType,
        label,
        sourceField,
      });
    }
  }
  productRelationCounts.set(materialNumber, counts);
  nodes.push({
    id: `model:${materialNumber}`,
    label: model,
    kind: "model",
    detail: valueAt(row, "Material Description (Global English)"),
    parentId: familyIds.get(valueAt(row, "Family Name")),
    family: valueAt(row, "Family Name"),
    materialNumber,
    productName: valueAt(row, "Material Description (Global English)"),
    imageUrl: valueAt(row, "Image URL"),
    sourceRow: row.sourceRow,
    verified: true,
    specifications: {
      maximumCapacity: valueAt(row, "Maximum Capacity {metric}"),
      readability: valueAt(row, "Readability {metric}"),
      stabilizationTime: valueAt(row, "Stabilization Time"),
      power: valueAt(row, "Power"),
      batteryLife: valueAt(row, "Battery Life"),
      panConstruction: valueAt(row, "Pan Construction"),
      dimensions: [
        valueAt(row, "Dimensions {Length} {metric}"),
        valueAt(row, "Dimensions {Width} {metric}"),
        valueAt(row, "Dimensions {Height} {metric}"),
      ].filter(Boolean).join(" × "),
    },
    relationshipCounts: counts,
  });
}

for (const materialNumber of [...referencedMaterials].sort()) {
  const row = materialLookup.get(materialNumber);
  const productName = row ? valueAt(row, "Material Description (Global English)") : "Workbook reference without a matching catalog row";
  const model = row ? valueAt(row, "Trade Name") : "";
  const relatedLinks = links.filter((link) => link.target === `part:${materialNumber}`);
  const relationshipCounts = {
    accessory: relatedLinks.filter((link) => link.relationType === "accessory").length,
    spare_part: relatedLinks.filter((link) => link.relationType === "spare_part").length,
  };
  nodes.push({
    id: `part:${materialNumber}`,
    label: model || productName || materialNumber,
    kind: "part",
    detail: row ? productName : `Part ${materialNumber} is referenced by portable balances but has no matching product row in this workbook.`,
    parentId: null,
    family: row ? valueAt(row, "Family Name") : "Unresolved reference",
    parentFamily: row ? valueAt(row, "Parent Family Name") : "Unresolved reference",
    materialNumber,
    productName,
    imageUrl: row ? valueAt(row, "Image URL") : "",
    sourceRow: row?.sourceRow ?? null,
    verified: Boolean(row),
    relationshipCounts,
  });
}

const sourceBytes = fs.readFileSync(sourcePath);
const familyCounts = Object.fromEntries(
  familyNames.map((family) => [family, portableRows.filter((row) => valueAt(row, "Family Name") === family).length]),
);
const resolvedParts = [...referencedMaterials].filter((material) => materialLookup.has(material)).length;
const payload = {
  metadata: {
    schemaVersion: "1.0.0",
    sourceFile: path.basename(sourcePath),
    sourceSha256: crypto.createHash("sha256").update(sourceBytes).digest("hex"),
    selectionRule: "Raw_Data: Parent Family Name = Portable Balances",
    sourceRows: catalogRows.length,
    sourceColumns: headers.length,
    portableProducts: portableRows.length,
    portableFamilies: familyNames.length,
    familyCounts,
    uniqueRelatedParts: referencedMaterials.size,
    resolvedParts,
    unresolvedParts: referencedMaterials.size - resolvedParts,
    accessoryLinks: links.filter((link) => link.relationType === "accessory").length,
    sparePartLinks: links.filter((link) => link.relationType === "spare_part").length,
    relationshipLinks: links.length,
    generatedAt: new Date().toISOString(),
  },
  nodes,
  links,
};

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(payload)}\n`);
console.log(JSON.stringify({ output: outputPath, ...payload.metadata }, null, 2));
