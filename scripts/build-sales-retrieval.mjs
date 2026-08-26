import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const catalogPath = path.resolve(process.argv[2] ?? path.join(appRoot, "data/portable-balances-api.json"));
const dataRoot = path.join(appRoot, "data");
const ragRoot = path.join(dataRoot, "sales-rag");
const productRoot = path.join(ragRoot, "products");
const familyRoot = path.join(ragRoot, "families");
const indexPath = path.join(dataRoot, "sales-retrieval-index.json");
const qualityPath = path.join(dataRoot, "sales-data-quality-report.json");
const versionPath = path.join(dataRoot, "sales-catalog-version.json");
const manifestPath = path.join(ragRoot, "manifest.json");

const rawCatalog = await readFile(catalogPath, "utf8");
const catalog = JSON.parse(rawCatalog);
const products = catalog.records.filter((record) => record.record_type === "portable_balance");
const relatedItems = catalog.records.filter((record) => record.record_type === "related_item");
const byMaterial = new Map(catalog.records.map((record) => [String(record.material_number), record]));
const generatedAt = new Date().toISOString();
const catalogSha256 = createHash("sha256").update(rawCatalog).digest("hex");

function slug(value) {
  return String(value ?? "")
    .replaceAll("™", "")
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase() || "unnamed";
}

function label(value) {
  return String(value ?? "")
    .replaceAll("_", " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function text(value) {
  if (value === null || value === undefined || value === "") return "";
  if (Array.isArray(value)) return value.map(text).filter(Boolean).join("; ");
  if (typeof value === "object" && "display" in value) return String(value.display ?? "");
  if (typeof value === "object") return Object.entries(value)
    .map(([key, child]) => `${label(key)}: ${text(child)}`)
    .filter((entry) => !entry.endsWith(": "))
    .join("; ");
  return String(value);
}

function md(value) {
  return text(value).replaceAll("|", "\\|").replace(/\r?\n/g, " ").trim();
}

function frontmatterValue(value) {
  return JSON.stringify(String(value ?? ""));
}

function table(rows) {
  const populated = rows.filter(([, value]) => text(value));
  if (populated.length === 0) return "_Not provided in the source workbook._";
  return [
    "| Field | Source value |",
    "| --- | --- |",
    ...populated.map(([field, value]) => `| ${md(field)} | ${md(value)} |`),
  ].join("\n");
}

function relationshipRows(record) {
  const rows = [];
  for (const [relationshipType, materials] of Object.entries(record.relationships ?? {})) {
    const related = materials.map((material) => {
      const item = byMaterial.get(String(material));
      const name = item?.model || item?.product_name;
      return name ? `${material} — ${name}` : `${material} — needs source review`;
    });
    rows.push([label(relationshipType), related]);
  }
  return rows;
}

function documentRows(record) {
  return Object.entries(record.documents ?? {}).map(([documentType, urls]) => [
    label(documentType),
    (urls ?? []).map((url) => `[${label(documentType)}](${url})`).join("; "),
  ]);
}

function productMarkdown(record) {
  const sales = record.sales_content ?? {};
  const benefits = [1, 2, 3].flatMap((index) => {
    const headline = sales[`benefit_headline_${index}`];
    const detail = sales[`benefit_text_${index}`];
    return headline || detail ? [`- **${md(headline || `Benefit ${index}`)}:** ${md(detail)}`] : [];
  });
  const salesRows = Object.entries(sales)
    .filter(([key]) => !key.startsWith("benefit_") && !["search_index", "ai_summary"].includes(key))
    .map(([key, value]) => [label(key), value]);
  const attributeRows = Object.entries(record.additional_attributes ?? {})
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => [label(key), value]);

  return [
    "---",
    `document_type: ${frontmatterValue("product")}`,
    `material_number: ${frontmatterValue(record.material_number)}`,
    `model: ${frontmatterValue(record.model)}`,
    `family: ${frontmatterValue(record.family)}`,
    `source_file: ${frontmatterValue(record.source?.file ?? catalog.metadata.source_file)}`,
    `catalog_source_sha256: ${frontmatterValue(catalog.metadata.source_sha256 ?? "not recorded")}`,
    "---",
    "",
    `# ${record.model} — ${record.product_name}`,
    "",
    `> Workbook-grounded product record. Material number **${record.material_number}** is the authoritative identifier.`,
    "",
    "## Identity",
    "",
    table([
      ["Material number", record.material_number],
      ["Model", record.model],
      ["Product name", record.product_name],
      ["Family", record.family],
      ["Country of origin", record.commercial?.country_of_origin],
    ]),
    "",
    "## Exact specifications",
    "",
    table([
      ["Maximum capacity", record.specifications?.maximum_capacity],
      ["Readability", record.specifications?.readability],
      ["Stabilization time", record.specifications?.stabilization_time],
      ["Power", record.specifications?.power],
      ["Battery life", record.specifications?.battery_life],
      ["Legal for trade", record.specifications?.legal_for_trade],
      ["Pan construction", record.specifications?.pan_construction],
    ]),
    "",
    "## Product description and sales context",
    "",
    md(sales.family_description || sales.ai_summary) || "_Not provided in the source workbook._",
    "",
    sales.tag_line ? `**Tag line:** ${md(sales.tag_line)}` : "",
    "",
    benefits.length > 0 ? ["### Source-listed benefits", "", ...benefits].join("\n") : "",
    "",
    table(salesRows),
    "",
    "## Additional populated workbook fields",
    "",
    table(attributeRows),
    "",
    "## Source-linked relationships",
    "",
    table(relationshipRows(record)),
    "",
    "## Source-linked documents",
    "",
    table(documentRows(record)),
    "",
    "## Source",
    "",
    `- Workbook: ${record.source?.file ?? catalog.metadata.source_file}`,
    `- Selection rule: ${record.source?.selection_rule ?? catalog.metadata.selection_rule}`,
    `- Material number: ${record.material_number}`,
    "",
  ].filter((line, index, lines) => line !== "" || lines[index - 1] !== "").join("\n");
}

function familyMarkdown(family, familyProducts) {
  const descriptions = [...new Set(familyProducts.map((product) => product.sales_content?.family_description).filter(Boolean))];
  const applications = [...new Set(familyProducts.flatMap((product) => {
    const value = product.sales_content?.application;
    return Array.isArray(value) ? value : value ? [value] : [];
  }))];
  const rows = familyProducts.map((product) => [
    product.model,
    product.material_number,
    product.specifications?.maximum_capacity?.display,
    product.specifications?.readability?.display,
    product.specifications?.power,
    product.specifications?.battery_life,
  ]);
  return [
    "---",
    `document_type: ${frontmatterValue("family")}`,
    `family: ${frontmatterValue(family)}`,
    `source_file: ${frontmatterValue(catalog.metadata.source_file)}`,
    `catalog_source_sha256: ${frontmatterValue(catalog.metadata.source_sha256 ?? "not recorded")}`,
    "---",
    "",
    `# ${family}`,
    "",
    `> Workbook-grounded family summary covering ${familyProducts.length} portable-balance records.`,
    "",
    "## Family description",
    "",
    descriptions.join("\n\n") || "_Not provided in the source workbook._",
    "",
    "## Source-listed applications",
    "",
    applications.length > 0 ? applications.map((application) => `- ${md(application)}`).join("\n") : "_Not provided in the source workbook._",
    "",
    "## Product range",
    "",
    "| Model | Material number | Maximum capacity | Readability | Power | Battery life |",
    "| --- | --- | --- | --- | --- | --- |",
    ...rows.map((row) => `| ${row.map(md).join(" | ")} |`),
    "",
    "## Source",
    "",
    `- Workbook: ${catalog.metadata.source_file}`,
    `- Selection rule: ${catalog.metadata.selection_rule}`,
    "",
  ].join("\n");
}

async function resetMarkdownDirectory(directory) {
  await mkdir(directory, { recursive: true });
  for (const filename of await readdir(directory)) {
    if (filename.endsWith(".md")) await unlink(path.join(directory, filename));
  }
}

await Promise.all([resetMarkdownDirectory(productRoot), resetMarkdownDirectory(familyRoot)]);

const documents = [];
for (const product of products) {
  const filename = `${slug(product.material_number)}-${slug(product.model)}.md`;
  const relativePath = path.posix.join("data", "sales-rag", "products", filename);
  const content = productMarkdown(product);
  await writeFile(path.join(productRoot, filename), content, "utf8");
  documents.push({
    document_id: `product:${product.material_number}`,
    document_type: "product",
    path: relativePath,
    title: `${product.model} — ${product.product_name}`,
    material_number: String(product.material_number),
    model: product.model,
    family: product.family,
    source_file: product.source?.file ?? catalog.metadata.source_file,
    source_fields: ["specifications", "sales_content", "additional_attributes", "relationships", "documents"],
    content,
  });
}

const productsByFamily = new Map();
for (const product of products) {
  const group = productsByFamily.get(product.family) ?? [];
  group.push(product);
  productsByFamily.set(product.family, group);
}
for (const [family, familyProducts] of [...productsByFamily].sort(([left], [right]) => left.localeCompare(right))) {
  const filename = `${slug(family)}.md`;
  const relativePath = path.posix.join("data", "sales-rag", "families", filename);
  const content = familyMarkdown(family, familyProducts);
  await writeFile(path.join(familyRoot, filename), content, "utf8");
  documents.push({
    document_id: `family:${slug(family)}`,
    document_type: "family",
    path: relativePath,
    title: family,
    material_number: null,
    model: null,
    family,
    source_file: catalog.metadata.source_file,
    source_fields: ["sales_content.family_description", "sales_content.application", "specifications"],
    content,
  });
}

const requiredPaths = [
  ["material_number", (record) => record.material_number],
  ["model", (record) => record.model],
  ["product_name", (record) => record.product_name],
  ["family", (record) => record.family],
  ["specifications.maximum_capacity", (record) => record.specifications?.maximum_capacity?.value],
  ["specifications.readability", (record) => record.specifications?.readability?.value],
  ["source.file", (record) => record.source?.file],
];
const missingRequired = products.flatMap((product) => requiredPaths.flatMap(([field, getter]) => {
  const value = getter(product);
  return value === null || value === undefined || value === ""
    ? [{ material_number: product.material_number, model: product.model, field }]
    : [];
}));
const materialGroups = Map.groupBy(products, (product) => String(product.material_number));
const duplicateMaterials = [...materialGroups].flatMap(([materialNumber, matches]) => (
  matches.length > 1 ? [{ material_number: materialNumber, record_count: matches.length }] : []
));
const modelGroups = Map.groupBy(products, (product) => product.model);
const ambiguousModels = [...modelGroups].flatMap(([model, matches]) => (
  matches.length > 1 ? [{ model, material_numbers: matches.map((product) => product.material_number) }] : []
));
const missingDocuments = products.flatMap((product) => [
  ...(!product.documents?.data_sheet?.length ? [{ material_number: product.material_number, model: product.model, document_type: "data_sheet" }] : []),
  ...(!product.documents?.manual?.length ? [{ material_number: product.material_number, model: product.model, document_type: "manual" }] : []),
]);
const fieldCompleteness = Object.fromEntries(requiredPaths.map(([field, getter]) => {
  const populated = products.filter((product) => {
    const value = getter(product);
    return value !== null && value !== undefined && value !== "";
  }).length;
  return [field, { populated, missing: products.length - populated, completeness_percent: Number((populated / products.length * 100).toFixed(1)) }];
}));

const unresolvedRelationshipGroups = new Set(catalog.unresolved_relationships.map((item) => (
  `${item.relationship_type}|${item.related_material_number}|${item.source_field}`
))).size;
const errors = missingRequired.length + duplicateMaterials.length;
const warningCount = ambiguousModels.length + unresolvedRelationshipGroups + missingDocuments.length + 3;
const qualityReport = {
  report_version: "1.0.0",
  generated_at: generatedAt,
  status: errors > 0 ? "blocked" : warningCount > 0 ? "review_required" : "ready",
  source_file: catalog.metadata.source_file,
  source_sha256: catalog.metadata.source_sha256 ?? null,
  selection_rule: catalog.metadata.selection_rule,
  summary: {
    errors,
    warnings: warningCount,
    affected_unresolved_relationship_edges: catalog.unresolved_relationships.length,
    portable_products: products.length,
    related_items: relatedItems.length,
    retrieval_documents: documents.length,
  },
  field_completeness: fieldCompleteness,
  errors: {
    missing_required_fields: missingRequired,
    duplicate_material_numbers: duplicateMaterials,
  },
  review_items: {
    ambiguous_model_labels: ambiguousModels,
    unresolved_relationships: catalog.unresolved_relationships,
    missing_documents: missingDocuments,
    known_source_gaps: [
      "No lifecycle status, effective date, or replacement material field is present.",
      "Live price, inventory, lead time, discounts, and regional availability are not present.",
      "Replacement and upsell relationship coverage is not established for the portable-balance catalog.",
    ],
  },
};

const retrievalIndex = {
  index_version: "1.0.0",
  generated_at: generatedAt,
  source_file: catalog.metadata.source_file,
  source_sha256: catalog.metadata.source_sha256 ?? null,
  catalog_sha256: catalogSha256,
  document_count: documents.length,
  product_document_count: products.length,
  family_document_count: productsByFamily.size,
  documents,
};
const manifest = {
  manifest_version: "1.0.0",
  generated_at: generatedAt,
  source_file: catalog.metadata.source_file,
  source_sha256: catalog.metadata.source_sha256 ?? null,
  documents: documents.map((document) => ({
    document_id: document.document_id,
    document_type: document.document_type,
    path: document.path,
    sha256: createHash("sha256").update(document.content).digest("hex"),
  })),
};
const versionReport = {
  catalog_schema_version: catalog.metadata.catalog_schema_version ?? "1.0.0",
  retrieval_schema_version: retrievalIndex.index_version,
  generated_at: generatedAt,
  source: {
    file: catalog.metadata.source_file,
    sha256: catalog.metadata.source_sha256 ?? null,
    bytes: catalog.metadata.source_bytes ?? null,
    rows: catalog.metadata.source_rows ?? null,
    columns: catalog.metadata.source_columns ?? null,
    selection_rule: catalog.metadata.selection_rule,
  },
  catalog: {
    sha256: catalogSha256,
    portable_products: products.length,
    portable_families: productsByFamily.size,
    related_items: relatedItems.length,
    records: catalog.records.length,
    retrieval_documents: documents.length,
  },
  quality_status: qualityReport.status,
};

await Promise.all([
  writeFile(indexPath, `${JSON.stringify(retrievalIndex)}\n`, "utf8"),
  writeFile(qualityPath, `${JSON.stringify(qualityReport, null, 2)}\n`, "utf8"),
  writeFile(versionPath, `${JSON.stringify(versionReport, null, 2)}\n`, "utf8"),
  writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8"),
]);

console.log(JSON.stringify({
  catalog: catalogPath,
  product_documents: products.length,
  family_documents: productsByFamily.size,
  retrieval_index: indexPath,
  quality_status: qualityReport.status,
  quality_errors: errors,
  quality_warnings: warningCount,
}, null, 2));
