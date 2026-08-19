import fs from "node:fs/promises";
import path from "node:path";

const sourcePath = path.resolve("../tmp/ohaus_excel/ohaus_data.json");
const outputPath = path.resolve("public/data/ohaus-knowledge.json");
const source = JSON.parse(await fs.readFile(sourcePath, "utf8"));

function cleanAlias(value) {
  return String(value ?? "")
    .replace(/\*/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function expandAlias(value) {
  const cleaned = cleanAlias(value);
  if (!cleaned) return [];
  const aliases = new Set([cleaned]);
  const withoutQualifier = cleaned.replace(/\s+\((?:Fine|Full|Coarse)\)$/i, "");
  aliases.add(withoutQualifier);
  const optional = withoutQualifier.match(/^(.*)\(([A-Z])\)(.*)$/i);
  if (optional) {
    aliases.add(`${optional[1]}${optional[3]}`);
    aliases.add(`${optional[1]}${optional[2]}${optional[3]}`);
  }
  return [...aliases].filter(Boolean);
}

function aliasesFor(record) {
  const values = [
    ...String(record.model_group ?? "").split(/\s+\/\s+/),
    ...String(record.search_aliases ?? "").split("|"),
  ];
  return [...new Set(values.flatMap(expandAlias))].sort((a, b) => b.length - a.length);
}

function closeEnough(a, b, threshold) {
  return Math.abs(a - b) <= threshold;
}

function assess(record) {
  const messages = [];
  const { repeatability: rep, linearity: lin, tolerance: tol, ocl } = record;
  if (rep.value != null && lin.value != null && tol.value != null && rep.unit === lin.unit && lin.unit === tol.unit) {
    const calculated = rep.value + lin.value;
    if (!closeEnough(calculated, tol.value, 1e-9)) {
      messages.push(`Published tolerance ${tol.value} ${tol.unit} differs from repeatability + linearity (${calculated} ${tol.unit}).`);
    }
  }
  if (tol.value != null && tol.d != null && record.readability && tol.unit === record.readability_unit) {
    const calculatedD = tol.value / record.readability;
    if (!closeEnough(calculatedD, tol.d, 0.0001)) {
      messages.push(`Published tolerance converts to ${calculatedD}d, while the source lists ${tol.d}d.`);
    }
  }
  if (ocl.value != null && ocl.d != null && record.readability && ocl.unit === record.readability_unit) {
    const calculatedD = ocl.value / record.readability;
    if (!closeEnough(calculatedD, ocl.d, 0.0001)) {
      messages.push(`Published OCL converts to ${calculatedD}d, while the source lists ${ocl.d}d.`);
    }
  }
  if (record.source_pdf_page === 49) {
    messages.push("The source heading says 2d while the combined tolerance column reports 4d; component values remain internally consistent.");
  }
  return { status: messages.length ? "review" : "ok", messages };
}

function component(value) {
  return {
    value: value?.value ?? null,
    secondaryValue: value?.value_secondary ?? null,
    unit: value?.unit ?? null,
    secondaryUnit: value?.unit_secondary ?? null,
    d: value?.d ?? null,
    raw: value?.raw ?? null,
  };
}

const current = source.current.map((record, index) => ({
  id: `CUR-${String(index + 1).padStart(4, "0")}`,
  lifecycle: [79, 80].includes(record.source_pdf_page) ? "legacy" : "current",
  series: record.series,
  tableTitle: record.table_title,
  modelGroup: cleanAlias(record.model_group),
  aliases: aliasesFor(record),
  capacity: {
    value: record.capacity_primary,
    unit: record.capacity_primary_unit,
    secondaryValue: record.capacity_secondary,
    secondaryUnit: record.capacity_secondary_unit,
    note: record.capacity_annotation ?? null,
  },
  readability: {
    value: record.readability,
    unit: record.readability_unit,
    secondaryValue: record.readability_secondary ?? null,
    secondaryUnit: record.readability_secondary_unit ?? null,
    note: record.readability_annotation ?? null,
  },
  repeatability: component(record.repeatability),
  linearity: component(record.linearity),
  ocl: component(record.ocl),
  tolerance: component(record.tolerance),
  calibration: { astm: record.astm_class || null, oiml: record.oiml_class || null },
  source: { manual: record.source_manual, page: record.source_pdf_page },
  qa: assess(record),
}));

const legacy = source.legacy.map((record, index) => ({
  id: `LEG-${String(index + 1).padStart(4, "0")}`,
  lifecycle: "legacy",
  series: record.series,
  tableTitle: record.table_title,
  modelGroup: cleanAlias(record.model_group),
  aliases: aliasesFor(record),
  repeatability: component(record.repeatability),
  linearity: component(record.linearity),
  ocl: component(record.ocl),
  source: { manual: record.source_manual, page: record.source_pdf_page },
}));

const output = {
  meta: {
    title: "OHAUS Master Tolerance Reference",
    documentDate: source.document_date,
    currentRecords: current.length,
    legacyRecords: legacy.length,
    temperatureRecords: source.temperature_specs.length,
    knownQaItems: 21,
  },
  current,
  legacy,
  temperatureSpecs: source.temperature_specs,
  classCrossMap: source.weight_class_crossmap,
  seriesClassRecommendations: source.series_class_recommendations,
  massTolerances: source.mass_tolerances,
  guidance: source.guidance,
};

await fs.mkdir(path.dirname(outputPath), { recursive: true });
await fs.writeFile(outputPath, JSON.stringify(output), "utf8");
console.log(`Prepared ${current.length + legacy.length} model records at ${outputPath}`);
