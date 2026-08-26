import catalog from "../data/portable-balances-api.json" with { type: "json" };
import retrievalIndex from "../data/sales-retrieval-index.json" with { type: "json" };

const records = catalog.records;
const products = records.filter((record) => record.record_type === "portable_balance");
const relatedItems = records.filter((record) => record.record_type === "related_item");
export const MAX_RETRIEVAL_DOCUMENTS = 20;
const MAX_CATALOG_SEARCH_RESULTS = 40;
const byMaterial = new Map(records.map((record) => [String(record.material_number), record]));
const productsByModel = new Map();
const retrievalReady = Boolean(
  retrievalIndex.source_sha256
  && catalog.metadata.source_sha256
  && retrievalIndex.source_sha256 === catalog.metadata.source_sha256,
);

for (const product of products) {
  const key = normalize(product.model);
  const matches = productsByModel.get(key) ?? [];
  matches.push(product);
  productsByModel.set(key, matches);
}

const querySynonyms = new Map([
  ["portable", ["battery", "small", "mobile", "outdoor"]],
  ["field", ["outdoor", "mobile", "battery"]],
  ["factory", ["industrial", "production", "warehouse"]],
  ["lab", ["laboratory"]],
  ["school", ["education", "classroom"]],
  ["washdown", ["wet", "water", "protection"]],
  ["accurate", ["readability", "resolution"]],
  ["capacity", ["maximum", "load", "weight"]],
  ["dimensions", ["height", "length", "width", "size"]],
  ["interface", ["communication", "usb", "rs232", "ethernet"]],
]);

const fieldAliases = {
  capacity: "specifications.maximum_capacity",
  maximum_capacity: "specifications.maximum_capacity",
  readability: "specifications.readability",
  stabilization_time: "specifications.stabilization_time",
  power: "specifications.power",
  battery_life: "specifications.battery_life",
  construction: "sales_content.construction",
  dimensions: "sales_content.dimensions",
  features: "sales_content.key_features",
  application: "sales_content.application",
  environment: "sales_content.working_environment_metric",
  units: "sales_content.units_of_measurement",
  legal_for_trade: "specifications.legal_for_trade",
};

function normalize(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .trim()
    .toLowerCase();
}

function tokenize(value) {
  const base = normalize(value).split(" ").filter((token) => token.length > 1);
  const expanded = [...base];
  for (const token of base) expanded.push(...(querySynonyms.get(token) ?? []));
  return [...new Set(expanded)];
}

function displayValue(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "object" && !Array.isArray(value) && "display" in value) return value.display;
  if (Array.isArray(value)) return value.join("; ");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function flattenScalars(value, prefix = "", output = []) {
  if (value === null || value === undefined || value === "") return output;
  if (Array.isArray(value)) {
    value.forEach((item) => flattenScalars(item, prefix, output));
    return output;
  }
  if (typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      flattenScalars(child, prefix ? `${prefix}.${key}` : key, output);
    }
    return output;
  }
  output.push({ path: prefix, value });
  return output;
}

function getPath(record, requestedPath) {
  const path = fieldAliases[requestedPath] ?? requestedPath;
  if (path === "sales_content.dimensions") {
    return {
      height: record.sales_content?.dimensions_height_metric ?? null,
      length: record.sales_content?.dimensions_length_metric ?? null,
      width: record.sales_content?.dimensions_width_metric ?? null,
    };
  }
  return path.split(".").reduce((current, key) => current?.[key], record);
}

function coreProduct(record) {
  return {
    material_number: record.material_number,
    model: record.model,
    product_name: record.product_name,
    family: record.family,
    maximum_capacity: record.specifications?.maximum_capacity ?? null,
    readability: record.specifications?.readability ?? null,
    power: record.specifications?.power ?? null,
    battery_life: record.specifications?.battery_life ?? null,
    application: record.sales_content?.application ?? null,
    key_features: record.sales_content?.key_features ?? [],
    usage_context: record.sales_content?.usage_context ?? [],
    source_file: record.source?.file ?? catalog.metadata.source_file,
  };
}

function compactRecord(record, sections = ["all"]) {
  const includeAll = sections.includes("all");
  const include = (section) => includeAll || sections.includes(section);
  if (record.record_type === "related_item") {
    return {
      record_type: record.record_type,
      material_number: record.material_number,
      product_name: record.product_name,
      parent_family: record.parent_family,
      family: record.family,
      country_of_origin: record.country_of_origin,
      summary: record.summary,
      image_url: record.image_url,
      source: record.source,
    };
  }
  return {
    record_type: record.record_type,
    material_number: record.material_number,
    model: record.model,
    product_name: record.product_name,
    family: record.family,
    ...(include("commercial") ? { commercial: record.commercial } : {}),
    ...(include("specifications") ? { specifications: record.specifications } : {}),
    ...(include("sales_content") ? { sales_content: record.sales_content } : {}),
    ...(include("additional_attributes") ? { additional_attributes: record.additional_attributes } : {}),
    ...(include("relationships") ? { relationships: record.relationships } : {}),
    ...(include("documents") ? { documents: record.documents } : {}),
    image_url: record.image_url,
    ...(include("source") || includeAll ? { source: record.source } : {}),
  };
}

function resolveIdentifier(identifier) {
  const raw = String(identifier ?? "").trim();
  const exactMaterial = byMaterial.get(raw);
  if (exactMaterial) return { status: "found", record: exactMaterial };
  const matches = productsByModel.get(normalize(raw)) ?? [];
  if (matches.length === 1) return { status: "found", record: matches[0] };
  if (matches.length > 1) return { status: "ambiguous", records: matches };
  return { status: "not_found" };
}

function searchableFields(record) {
  return flattenScalars(record)
    .filter(({ path }) => !path.endsWith("image_url") && !path.includes("documents"));
}

function scoreRecord(record, query) {
  const normalizedQuery = normalize(query);
  const tokens = tokenize(query);
  const fields = searchableFields(record);
  const material = normalize(record.material_number);
  const model = normalize(record.model);
  let score = 0;
  const matchedFields = [];

  if (normalizedQuery === material || normalizedQuery === model) score += 1_000;
  if (material && normalizedQuery.includes(material)) score += 450;
  if (model && normalizedQuery.includes(model)) score += 400;

  for (const field of fields) {
    const normalizedValue = normalize(field.value);
    if (!normalizedValue) continue;
    let fieldScore = 0;
    if (normalizedQuery.length > 2 && normalizedValue.includes(normalizedQuery)) fieldScore += 140;
    for (const token of tokens) {
      if (normalizedValue === token) fieldScore += 34;
      else if (normalizedValue.includes(token)) fieldScore += 9;
    }
    if (fieldScore > 0) {
      score += fieldScore;
      matchedFields.push({ field: field.path, value: displayValue(field.value), score: fieldScore });
    }
  }

  return {
    score,
    matchedFields: matchedFields
      .sort((left, right) => right.score - left.score)
      .slice(0, 16)
      .map(({ field, value }) => ({ field, value })),
  };
}

export function searchCatalog({ query, record_type = "any", limit = 20 }) {
  const candidates = record_type === "portable_balance"
    ? products
    : record_type === "related_item"
      ? relatedItems
      : records;

  const ranked = candidates
    .map((record) => ({ record, ...scoreRecord(record, query) }))
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score || String(left.record.material_number).localeCompare(String(right.record.material_number)));
  const selected = ranked.slice(0, Math.max(1, Math.min(Number(limit) || 20, MAX_CATALOG_SEARCH_RESULTS)));

  return {
    query,
    record_type,
    total_matches: ranked.length,
    result_count: selected.length,
    results: selected.map(({ record, score, matchedFields }) => ({
      score,
      matched_fields: matchedFields,
      record: record.record_type === "portable_balance" ? coreProduct(record) : compactRecord(record),
    })),
  };
}

function retrievalExcerpt(content, tokens, maximum = 1_240) {
  const plain = String(content ?? "")
    .replace(/^---[\s\S]*?---\s*/m, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[#*`>|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (plain.length <= maximum) return plain;
  const normalizedPlain = normalize(plain);
  const matchedToken = tokens.find((token) => normalizedPlain.includes(token));
  const rawIndex = matchedToken ? plain.toLowerCase().indexOf(matchedToken.toLowerCase()) : 0;
  const start = Math.max(0, rawIndex - Math.floor(maximum / 3));
  const excerpt = plain.slice(start, start + maximum);
  return `${start > 0 ? "…" : ""}${excerpt}${start + maximum < plain.length ? "…" : ""}`;
}

export function searchRetrievalDocuments({ query, document_type = "any", limit = MAX_RETRIEVAL_DOCUMENTS }) {
  if (!retrievalReady) {
    return { status: "stale", query, document_type, total_matches: 0, result_count: 0, results: [] };
  }
  const normalizedQuery = normalize(query);
  const tokens = tokenize(query);
  const candidates = retrievalIndex.documents.filter((document) => (
    document_type === "any" || document.document_type === document_type
  ));
  const ranked = candidates.map((document) => {
    const title = normalize(document.title);
    const identifiers = normalize(`${document.material_number ?? ""} ${document.model ?? ""} ${document.family ?? ""}`);
    const content = normalize(document.content);
    let score = 0;
    if (normalizedQuery.length > 2 && title.includes(normalizedQuery)) score += 240;
    if (normalizedQuery.length > 2 && identifiers.includes(normalizedQuery)) score += 220;
    if (normalizedQuery.length > 4 && content.includes(normalizedQuery)) score += 90;
    for (const token of tokens) {
      if (identifiers.split(" ").includes(token)) score += 32;
      else if (identifiers.includes(token)) score += 18;
      if (title.includes(token)) score += 14;
      if (content.includes(token)) score += 4;
    }
    return { document, score };
  }).filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score || left.document.document_id.localeCompare(right.document.document_id));
  const requestedLimit = Math.max(1, Math.min(Number(limit) || MAX_RETRIEVAL_DOCUMENTS, MAX_RETRIEVAL_DOCUMENTS));
  const selected = [];
  const selectedIds = new Set();
  const representedFamilies = new Set();
  const relevanceFloor = (ranked[0]?.score ?? 0) * 0.55;

  // Descriptive text is often repeated across every model in a family. First
  // surface one strongly relevant document per family, then fill remaining
  // positions by score. Exact model and numeric selection use structured data.
  for (const candidate of ranked) {
    if (selected.length >= requestedLimit || candidate.score < relevanceFloor) break;
    const family = candidate.document.family || candidate.document.document_id;
    if (representedFamilies.has(family)) continue;
    selected.push(candidate);
    selectedIds.add(candidate.document.document_id);
    representedFamilies.add(family);
  }
  for (const candidate of ranked) {
    if (selected.length >= requestedLimit) break;
    if (selectedIds.has(candidate.document.document_id)) continue;
    selected.push(candidate);
    selectedIds.add(candidate.document.document_id);
  }
  return {
    status: "ready",
    query,
    document_type,
    total_matches: ranked.length,
    result_count: selected.length,
    results: selected.map(({ document, score }) => ({
      score,
      document_id: document.document_id,
      document_type: document.document_type,
      title: document.title,
      material_number: document.material_number,
      model: document.model,
      family: document.family,
      source_file: document.source_file,
      source_fields: document.source_fields,
      excerpt: retrievalExcerpt(document.content, tokens),
    })),
  };
}

export function getRecords({ identifiers, sections = ["all"] }) {
  const requested = Array.isArray(identifiers) ? identifiers.slice(0, 24) : [];
  return {
    results: requested.map((identifier) => {
      const resolved = resolveIdentifier(identifier);
      if (resolved.status === "found") {
        return { identifier, status: "found", record: compactRecord(resolved.record, sections) };
      }
      if (resolved.status === "ambiguous") {
        return {
          identifier,
          status: "ambiguous",
          message: "This model label maps to more than one material number.",
          candidates: resolved.records.map(coreProduct),
        };
      }
      return { identifier, status: "not_found" };
    }),
  };
}

export function compareProducts({ identifiers, fields }) {
  const requestedFields = Array.isArray(fields) && fields.length > 0 ? fields.slice(0, 20) : ["all"];
  const resolutions = (identifiers ?? []).slice(0, 6).map((identifier) => ({ identifier, ...resolveIdentifier(identifier) }));
  return {
    requested_identifiers: identifiers,
    unresolved: resolutions
      .filter(({ status }) => status !== "found")
      .map(({ identifier, status, records: ambiguousRecords }) => ({
        identifier,
        status,
        candidates: ambiguousRecords?.map(coreProduct) ?? [],
      })),
    comparisons: resolutions.flatMap(({ status, record }) => {
      if (status !== "found" || record.record_type !== "portable_balance") return [];
      if (requestedFields.includes("all")) return [compactRecord(record)];
      return [{
        material_number: record.material_number,
        model: record.model,
        family: record.family,
        fields: Object.fromEntries(requestedFields.map((field) => [field, getPath(record, field) ?? null])),
        source_file: record.source?.file ?? catalog.metadata.source_file,
      }];
    }),
  };
}

function includesAny(value, queries) {
  const haystack = normalize(Array.isArray(value) ? value.join(" ") : value);
  return queries.length === 0 || queries.some((query) => haystack.includes(normalize(query)));
}

export function filterProducts({
  minimum_capacity_g = null,
  maximum_capacity_g = null,
  maximum_readability_g = null,
  families = [],
  applications = [],
  usage_context = [],
  battery_required = null,
  legal_for_trade = null,
  search_terms = [],
  limit = 12,
}) {
  const matches = products.filter((product) => {
    const capacity = product.specifications?.maximum_capacity?.value;
    const readability = product.specifications?.readability?.value;
    if (minimum_capacity_g !== null && !(capacity >= minimum_capacity_g)) return false;
    if (maximum_capacity_g !== null && !(capacity <= maximum_capacity_g)) return false;
    if (maximum_readability_g !== null && !(readability <= maximum_readability_g)) return false;
    if (families.length > 0 && !includesAny(product.family, families)) return false;
    if (applications.length > 0 && !includesAny(product.sales_content?.application, applications)) return false;
    if (usage_context.length > 0 && !includesAny([
      ...(product.sales_content?.usage_context ?? []),
      ...(product.sales_content?.typical_areas ?? []),
      ...(product.sales_content?.market_worlds ?? []),
    ], usage_context)) return false;
    if (battery_required === true && !/batter/i.test(product.specifications?.power ?? "")) return false;
    if (battery_required === false && /batter/i.test(product.specifications?.power ?? "")) return false;
    if (legal_for_trade !== null && !includesAny(product.specifications?.legal_for_trade, [legal_for_trade])) return false;
    if (search_terms.length > 0 && scoreRecord(product, search_terms.join(" ")).score === 0) return false;
    return true;
  });

  return {
    criteria: {
      minimum_capacity_g,
      maximum_capacity_g,
      maximum_readability_g,
      families,
      applications,
      usage_context,
      battery_required,
      legal_for_trade,
      search_terms,
    },
    total_matches: matches.length,
    products: matches
      .sort((left, right) => (
        (left.specifications?.readability?.value ?? Number.POSITIVE_INFINITY)
        - (right.specifications?.readability?.value ?? Number.POSITIVE_INFINITY)
        || (left.specifications?.maximum_capacity?.value ?? 0) - (right.specifications?.maximum_capacity?.value ?? 0)
      ))
      .slice(0, Math.max(1, Math.min(Number(limit) || 12, 20)))
      .map(coreProduct),
  };
}

export function getRelationships({ material_number, relationship_type = "all" }) {
  const source = byMaterial.get(String(material_number));
  if (!source || source.record_type !== "portable_balance") {
    return { status: "not_found", material_number, relationships: [] };
  }
  const requestedTypes = relationship_type === "all" ? ["accessories", "spare_parts"] : [relationship_type];
  const relationships = [];
  for (const type of requestedTypes) {
    for (const relatedMaterial of source.relationships?.[type] ?? []) {
      const related = byMaterial.get(String(relatedMaterial));
      const unresolved = catalog.unresolved_relationships.find((edge) => (
        edge.source_material_number === source.material_number
        && edge.related_material_number === relatedMaterial
        && normalize(edge.relationship_type) === normalize(type)
      ));
      relationships.push({
        relationship_type: type,
        related_material_number: relatedMaterial,
        resolution_status: related ? "resolved" : "needs_source",
        related_item: related ? compactRecord(related) : null,
        source_field: unresolved?.source_field ?? `relationships.${type}`,
      });
    }
  }
  return {
    status: "found",
    source: {
      ...coreProduct(source),
      documents: source.documents,
    },
    relationship_count: relationships.length,
    relationships,
  };
}

const fieldIndex = (() => {
  const index = new Map();
  for (const product of products) {
    for (const { path, value } of flattenScalars(product)) {
      if (path.endsWith("image_url") || path.includes("documents")) continue;
      const entry = index.get(path) ?? { path, populated_records: 0, examples: [] };
      entry.populated_records += 1;
      const shown = displayValue(value);
      if (shown && !entry.examples.includes(shown) && entry.examples.length < 4) entry.examples.push(shown);
      index.set(path, entry);
    }
  }
  return [...index.values()];
})();

export function inspectCatalogFields({ query, limit = 20 }) {
  const tokens = tokenize(query);
  const ranked = fieldIndex
    .map((entry) => {
      const searchable = normalize(`${entry.path} ${entry.examples.join(" ")}`);
      const score = tokens.reduce((total, token) => total + (searchable.includes(token) ? 1 : 0), 0);
      return { ...entry, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || right.populated_records - left.populated_records)
    .slice(0, Math.max(1, Math.min(Number(limit) || 20, 30)));
  return { query, fields: ranked };
}

export function getCatalogOverview() {
  return {
    ...catalog.metadata,
    retrieval_documents: retrievalIndex.document_count,
    product_retrieval_documents: retrievalIndex.product_document_count,
    family_retrieval_documents: retrievalIndex.family_document_count,
    retrieval_status: retrievalReady ? "ready" : "stale",
    supported_product_scope: "Portable Balances",
    families: catalog.metadata.family_counts,
    available_field_count: fieldIndex.length,
    important_field_groups: [
      "commercial",
      "specifications",
      "sales_content",
      "additional_attributes",
      "relationships",
      "documents",
    ],
    known_missing_business_data: [
      "live price",
      "live inventory",
      "lead time",
      "customer-specific discount",
      "current regional availability",
    ],
  };
}

export function hydrateEvidenceItems(items) {
  if (!Array.isArray(items)) return [];
  return items.slice(0, 48).flatMap((item) => {
    const record = byMaterial.get(String(item?.material_number ?? ""));
    const field = String(item?.field ?? "").trim();
    if (!record || !field) return [];
    const actualValue = getPath(record, field);
    const value = displayValue(actualValue);
    if (value === null) return [];
    return [{
      material_number: String(record.material_number),
      model_or_item: record.model ?? record.product_name ?? String(record.material_number),
      field,
      value,
      source_file: record.source?.file ?? catalog.metadata.source_file,
    }];
  });
}

function mentionedProductIdentifiers(text, contextMaterials = []) {
  const normalizedText = ` ${normalize(text)} `;
  const found = new Set(
    contextMaterials
      .map(String)
      .filter((material) => byMaterial.get(material)?.record_type === "portable_balance"),
  );
  for (const product of products) {
    const material = String(product.material_number);
    const model = normalize(product.model);
    if (normalizedText.includes(` ${normalize(material)} `) || (model && normalizedText.includes(` ${model} `))) {
      found.add(material);
    }
  }
  return [...found].slice(0, 24);
}

function truncateText(value, maximum = 320) {
  const text = String(value ?? "");
  return text.length <= maximum ? text : `${text.slice(0, maximum - 1)}…`;
}

function compactSearch(search, maximumResults = 8) {
  return {
    query: search.query,
    record_type: search.record_type,
    total_matches: search.total_matches,
    returned_matches: Math.min(search.results.length, maximumResults),
    results: search.results.slice(0, maximumResults).map((result) => ({
      score: result.score,
      matched_fields: result.matched_fields.slice(0, 8).map((match) => ({
        field: match.field,
        value: truncateText(match.value, 640),
      })),
      record: result.record.record_type === "related_item"
        ? {
          material_number: result.record.material_number,
          product_name: result.record.product_name,
          parent_family: result.record.parent_family,
          family: result.record.family,
          summary: truncateText(result.record.summary),
          source_file: result.record.source?.file ?? catalog.metadata.source_file,
        }
        : result.record,
    })),
  };
}

function compactRelationshipResult(result) {
  return {
    status: result.status,
    source: result.source ? coreProduct(byMaterial.get(String(result.source.material_number))) : null,
    relationship_count: result.relationship_count ?? 0,
    relationships: (result.relationships ?? []).map((relationship) => ({
      relationship_type: relationship.relationship_type,
      related_material_number: relationship.related_material_number,
      resolution_status: relationship.resolution_status,
      related_item: relationship.related_item ? {
        product_name: relationship.related_item.product_name,
        family: relationship.related_item.family,
        parent_family: relationship.related_item.parent_family,
        summary: truncateText(relationship.related_item.summary, 240),
      } : null,
      source_field: relationship.source_field,
    })),
  };
}

function isCompleteRecordRequest(question) {
  return /\b(?:all information|all details|all specifications|all specs|everything|complete|full|entire|tell me (?:all )?about)\b/i.test(question);
}

function compactExactResult(identifier, question) {
  const resolution = resolveIdentifier(identifier);
  if (resolution.status === "not_found") return { identifier, status: "not_found" };
  if (resolution.status === "ambiguous") {
    return { identifier, status: "ambiguous", candidates: resolution.records.map(coreProduct) };
  }
  const record = resolution.record;
  const wantsCompleteRecord = isCompleteRecordRequest(question);
  if (wantsCompleteRecord) {
    return {
      identifier,
      status: "found",
      record: compactRecord(record, ["all"]),
    };
  }
  const relevantFields = scoreRecord(record, question).matchedFields.map((match) => ({
    field: match.field,
    value: truncateText(match.value),
  }));
  return {
    identifier,
    status: "found",
    record: {
      ...coreProduct(record),
      relevant_fields: relevantFields,
      ...(/document|manual|datasheet|certificate|brochure/i.test(question) ? { documents: record.documents } : {}),
    },
  };
}

function grams(number, unit) {
  const value = Number(String(number).replaceAll(",", ""));
  if (!Number.isFinite(value)) return null;
  if (/^kg/i.test(unit)) return value * 1_000;
  if (/^mg/i.test(unit)) return value / 1_000;
  return value;
}

function deriveCapacityRequirement(question) {
  const text = String(question);
  if (!/capacit|load|weigh/i.test(text)) return null;
  const amountAfterField = text.match(/(?:capacit(?:y|ies)|load|weigh(?:ing)?)[^0-9]{0,32}(?<number>[\d,.]+)\s*(?<unit>kg|kilograms?|g|grams?|mg|milligrams?)/i);
  const amountBeforeField = text.match(/(?<number>[\d,.]+)\s*(?<unit>kg|kilograms?|g|grams?|mg|milligrams?)\s*(?:capacit(?:y|ies)|load|weigh(?:ing)?)/i);
  // Prefer a measurement immediately before "capacity" so a later readability
  // value cannot be mistaken for capacity in a multi-requirement question.
  const amount = amountBeforeField ?? amountAfterField;
  if (!amount?.groups) return null;
  const requestedValueG = grams(amount.groups.number, amount.groups.unit);
  if (requestedValueG === null) return null;

  let requirementType = "ambiguous";
  if (/\b(?:exactly|exact|specifically|precisely)\b/i.test(text)) requirementType = "exact";
  else if (/(?:at least|minimum(?: of)?|no less than|>=|or more|and above|must (?:handle|weigh)|needs? to (?:handle|weigh))/i.test(text)) requirementType = "minimum";
  else if (/(?:at most|maximum(?: of)?|no more than|<=|or less|and below|under|less than)/i.test(text)) requirementType = "maximum";
  else if (/\b(?:about|around|roughly|approximately|approximate|near|close to)\b/i.test(text)) requirementType = "approximate";

  return {
    field: "specifications.maximum_capacity",
    requested_value_g: requestedValueG,
    requested_display: `${amount.groups.number} ${amount.groups.unit}`,
    requirement_type: requirementType,
    clarification_needed: requirementType === "ambiguous",
  };
}

function rankedCapacityProducts(candidates, target, limit = 3) {
  const seenModels = new Set();
  const ranked = [...candidates].sort((left, right) => {
    const leftCapacity = left.specifications.maximum_capacity.value;
    const rightCapacity = right.specifications.maximum_capacity.value;
    return Math.abs(leftCapacity - target) - Math.abs(rightCapacity - target)
      || (left.specifications.readability?.value ?? Number.POSITIVE_INFINITY) - (right.specifications.readability?.value ?? Number.POSITIVE_INFINITY)
      || String(left.model).localeCompare(String(right.model));
  });
  const selected = [];
  for (const product of ranked) {
    const modelKey = normalize(product.model);
    if (seenModels.has(modelKey)) continue;
    seenModels.add(modelKey);
    selected.push({
      ...coreProduct(product),
      difference_from_request_g: product.specifications.maximum_capacity.value - target,
    });
    if (selected.length >= limit) break;
  }
  return selected;
}

export function findNearestCapacityAlternatives(question) {
  const requirement = deriveCapacityRequirement(question);
  if (!requirement) return null;
  const target = requirement.requested_value_g;
  const exact = products.filter((product) => product.specifications?.maximum_capacity?.value === target);
  const below = products.filter((product) => product.specifications?.maximum_capacity?.value < target);
  const above = products.filter((product) => product.specifications?.maximum_capacity?.value > target);
  const closestBelowCapacity = below.length > 0
    ? Math.max(...below.map((product) => product.specifications.maximum_capacity.value))
    : null;
  const closestAboveCapacity = above.length > 0
    ? Math.min(...above.map((product) => product.specifications.maximum_capacity.value))
    : null;
  const qualifying = requirement.requirement_type === "minimum"
    ? products.filter((product) => product.specifications.maximum_capacity.value >= target)
    : requirement.requirement_type === "maximum"
      ? products.filter((product) => product.specifications.maximum_capacity.value <= target)
      : requirement.requirement_type === "exact"
        ? exact
        : [];

  return {
    requirement,
    exact_match_count: exact.length,
    exact_matches: rankedCapacityProducts(exact, target),
    closest_below: closestBelowCapacity === null ? null : {
      capacity_g: closestBelowCapacity,
      difference_g: closestBelowCapacity - target,
      products: rankedCapacityProducts(below.filter((product) => product.specifications.maximum_capacity.value === closestBelowCapacity), target),
    },
    closest_above: closestAboveCapacity === null ? null : {
      capacity_g: closestAboveCapacity,
      difference_g: closestAboveCapacity - target,
      products: rankedCapacityProducts(above.filter((product) => product.specifications.maximum_capacity.value === closestAboveCapacity), target),
    },
    closest_qualifying_products: rankedCapacityProducts(qualifying, target),
    safety_note: "A product below a stated minimum capacity is not a qualifying alternative, even when it is numerically closer.",
  };
}

function deriveSelectionCriteria(question) {
  const text = String(question);
  const normalizedQuestion = normalize(text);
  const measurement = "([\\d,.]+)\\s*(kg|kilograms?|g|grams?|mg|milligrams?)";
  const capacityRequirement = deriveCapacityRequirement(text);
  let minimumCapacity = capacityRequirement?.requirement_type === "minimum" || capacityRequirement?.requirement_type === "exact"
    ? capacityRequirement.requested_value_g
    : null;
  let maximumCapacity = capacityRequirement?.requirement_type === "maximum" || capacityRequirement?.requirement_type === "exact"
    ? capacityRequirement.requested_value_g
    : null;
  let maximumReadability = null;

  if (/readability|resolution|increment/i.test(text)) {
    const readability = text.match(new RegExp(`(?:readability|resolution|increment)(?: of| at| up to| no more than)?\\s*${measurement}`, "i"))
      ?? text.match(new RegExp(`${measurement}\\s*(?:readability|resolution|increment|or better)`, "i"));
    if (readability) maximumReadability = grams(readability[1], readability[2]);
  }

  const families = Object.keys(catalog.metadata.family_counts ?? {})
    .filter((family) => normalizedQuestion.includes(normalize(family)))
    .slice(0, 4);
  const batteryRequired = /battery[- ]?(?:powered|power|operation)|run(?:s|ning)? on batter|with batter/i.test(text)
    ? true
    : null;
  const criteriaApplied = [minimumCapacity, maximumCapacity, maximumReadability, batteryRequired].some((value) => value !== null)
    || families.length > 0;
  if (!criteriaApplied) return null;

  return {
    minimum_capacity_g: minimumCapacity,
    maximum_capacity_g: maximumCapacity,
    maximum_readability_g: maximumReadability,
    families,
    applications: [],
    usage_context: [],
    battery_required: batteryRequired,
    legal_for_trade: null,
    search_terms: [],
    limit: 16,
  };
}

export function buildGroundingBundle({ question, sessionContext = [] }) {
  const explicitIdentifiers = mentionedProductIdentifiers(question, []);
  const isBroadNewQuestion = /\b(?:which|recommend|suggest|find|show|list|all models|all balances|compare)\b/i.test(question);
  const recentContextMaterials = explicitIdentifiers.length === 0 && !isBroadNewQuestion && Array.isArray(sessionContext)
    ? [...sessionContext].reverse().find((turn) => Array.isArray(turn?.materials) && turn.materials.length > 0)?.materials ?? []
    : [];
  const identifiers = explicitIdentifiers.length > 0
    ? explicitIdentifiers
    : mentionedProductIdentifiers(question, recentContextMaterials);
  const wantsRelationships = /accessor|spare|part|replacement|related|connect|compatible/i.test(question);
  const exact = identifiers.length > 0
    ? identifiers.map((identifier) => compactExactResult(identifier, question))
    : [];
  const productSearch = searchCatalog({
    query: question,
    record_type: "portable_balance",
    limit: MAX_CATALOG_SEARCH_RESULTS,
  });
  const wantsRelatedItems = /accessor|spare|part|replacement|related|adapter|case|printer|cable/i.test(question);
  const relatedSearch = wantsRelatedItems && identifiers.length === 0
    ? searchCatalog({ query: question, record_type: "related_item", limit: 20 })
    : { query: question, record_type: "related_item", total_matches: 0, result_count: 0, results: [] };
  const topicFields = inspectCatalogFields({ query: question, limit: 20 });
  const relationships = wantsRelationships
    ? identifiers.slice(0, 6).map((materialNumber) => compactRelationshipResult(getRelationships({
      material_number: materialNumber,
      relationship_type: /spare/i.test(question) ? "spare_parts" : /accessor/i.test(question) ? "accessories" : "all",
    })))
    : [];
  const selectionCriteria = deriveSelectionCriteria(question);
  const deterministicSelection = selectionCriteria ? filterProducts(selectionCriteria) : null;
  const nearestAlternatives = findNearestCapacityAlternatives(question);
  const completeExactRecordSupplied = identifiers.length > 0 && isCompleteRecordRequest(question);
  const retrievalDocuments = completeExactRecordSupplied
    ? {
      status: "ready",
      query: question,
      document_type: "any",
      total_matches: 0,
      result_count: 0,
      results: [],
      note: "Complete exact structured record supplied; descriptive retrieval documents are unnecessary for this request.",
    }
    : searchRetrievalDocuments({
      query: question,
      document_type: "any",
      limit: MAX_RETRIEVAL_DOCUMENTS,
    });
  const compactProductSearch = compactSearch({
    ...productSearch,
    results: productSearch.results.filter((result) => !identifiers.includes(String(result.record.material_number))),
  }, identifiers.length > 0 || deterministicSelection ? 0 : 20);

  return {
    bundle_version: "sales-grounding-v7",
    source_file: catalog.metadata.source_file,
    catalog_scope: getCatalogOverview(),
    user_question: question,
    exact_identifier_matches: exact,
    deterministic_selection_results: deterministicSelection,
    nearest_alternative_results: nearestAlternatives,
    retrieval_document_matches: retrievalDocuments,
    natural_language_product_matches: compactProductSearch,
    related_item_matches: compactSearch(relatedSearch, 20),
    relationship_results: relationships,
    topic_field_matches: {
      query: topicFields.query,
      fields: topicFields.fields.slice(0, 20).map((field) => ({
        path: field.path,
        populated_records: field.populated_records,
        examples: field.examples.slice(0, 4).map((example) => truncateText(example, 360)),
      })),
    },
  };
}

export const salesTools = [
  {
    type: "function",
    name: "search_catalog",
    description: "Hybrid search across every populated text and identifier field in the product catalog. Returns the best product or related-item matches with the fields that matched.",
    strict: true,
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
        record_type: { type: "string", enum: ["portable_balance", "related_item", "any"] },
        limit: { type: "integer", minimum: 1, maximum: 40 },
      },
      required: ["query", "record_type", "limit"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "search_retrieval_documents",
    description: "Search generated workbook-grounded product and family Markdown documents for descriptive sales context. Exact numeric requirements must still use filter_products or the structured catalog.",
    strict: true,
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
        document_type: { type: "string", enum: ["product", "family", "any"] },
        limit: { type: "integer", minimum: 1, maximum: 20 },
      },
      required: ["query", "document_type", "limit"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "get_records",
    description: "Retrieve authoritative records by exact material number or model. Use model ambiguity results to ask for the material number.",
    strict: true,
    parameters: {
      type: "object",
      properties: {
        identifiers: { type: "array", minItems: 1, maxItems: 24, items: { type: "string" } },
        sections: {
          type: "array",
          minItems: 1,
          items: { type: "string", enum: ["all", "commercial", "specifications", "sales_content", "additional_attributes", "relationships", "documents", "source"] },
        },
      },
      required: ["identifiers", "sections"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "compare_products",
    description: "Compare two to six products on any requested catalog field path. Common aliases include capacity, readability, power, battery_life, dimensions, construction, features, application, environment, units, and legal_for_trade.",
    strict: true,
    parameters: {
      type: "object",
      properties: {
        identifiers: { type: "array", minItems: 2, maxItems: 6, items: { type: "string" } },
        fields: { type: "array", minItems: 1, maxItems: 20, items: { type: "string" } },
      },
      required: ["identifiers", "fields"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "filter_products",
    description: "Deterministically shortlist portable balances using numeric capacity/readability requirements and catalog-backed family, application, usage, battery, legal-for-trade, or feature criteria.",
    strict: true,
    parameters: {
      type: "object",
      properties: {
        minimum_capacity_g: { type: ["number", "null"] },
        maximum_capacity_g: { type: ["number", "null"] },
        maximum_readability_g: { type: ["number", "null"] },
        families: { type: "array", items: { type: "string" } },
        applications: { type: "array", items: { type: "string" } },
        usage_context: { type: "array", items: { type: "string" } },
        battery_required: { type: ["boolean", "null"] },
        legal_for_trade: { type: ["string", "null"] },
        search_terms: { type: "array", items: { type: "string" } },
        limit: { type: "integer", minimum: 1, maximum: 20 },
      },
      required: ["minimum_capacity_g", "maximum_capacity_g", "maximum_readability_g", "families", "applications", "usage_context", "battery_required", "legal_for_trade", "search_terms", "limit"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "get_relationships",
    description: "List source-linked accessories and spare parts for a product. A listed relationship must not be described as universal compatibility unless the source explicitly says so.",
    strict: true,
    parameters: {
      type: "object",
      properties: {
        material_number: { type: "string" },
        relationship_type: { type: "string", enum: ["accessories", "spare_parts", "all"] },
      },
      required: ["material_number", "relationship_type"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "inspect_catalog_fields",
    description: "Find which workbook-derived fields exist for a topic before deciding that the catalog cannot answer a question.",
    strict: true,
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 30 },
      },
      required: ["query", "limit"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "get_catalog_overview",
    description: "Return loaded scope, families, record counts, field groups, and known missing business data. Use for broad capability or coverage questions.",
    strict: true,
    parameters: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
  },
];

export function runSalesTool(name, args) {
  if (name === "search_catalog") return searchCatalog(args);
  if (name === "search_retrieval_documents") return searchRetrievalDocuments(args);
  if (name === "get_records") return getRecords(args);
  if (name === "compare_products") return compareProducts(args);
  if (name === "filter_products") return filterProducts(args);
  if (name === "get_relationships") return getRelationships(args);
  if (name === "inspect_catalog_fields") return inspectCatalogFields(args);
  if (name === "get_catalog_overview") return getCatalogOverview();
  return { error: `Unknown tool: ${name}` };
}

export function getSalesCatalogStatus() {
  return getCatalogOverview();
}