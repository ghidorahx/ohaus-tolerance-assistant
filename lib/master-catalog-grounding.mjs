const MAX_GROUNDING_EVIDENCE = 48;

function asText(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function materialLabel(material, fallback) {
  return material?.model ?? material?.product_name ?? fallback;
}

function groupSupplementalEvidence(retrieval, materials, sourceFile) {
  const grouped = new Map();
  const add = ({ materialNumber, field, value }) => {
    const material = materials.get(String(materialNumber));
    const key = `${materialNumber}|${field}`;
    const current = grouped.get(key) ?? {
      material_number: String(materialNumber),
      model_or_item: materialLabel(material, String(materialNumber)),
      field,
      values: [],
      source_file: sourceFile,
    };
    if (value && !current.values.includes(value)) current.values.push(value);
    grouped.set(key, current);
  };

  for (const relationship of retrieval?.relationships ?? []) {
    const target = String(relationship.target_material_number ?? "").trim();
    if (!target) continue;
    const targetName = relationship.target_model ?? relationship.target_product_name;
    const resolution = Number(relationship.target_resolved) === 1 ? "catalog record resolved" : "listed reference; record unresolved";
    add({
      materialNumber: relationship.source_material_number,
      field: `relationships.${relationship.relationship_type || "related_item"}`,
      value: `${target}${targetName ? ` — ${targetName}` : ""} (${resolution})`,
    });
  }

  for (const document of retrieval?.documents ?? []) {
    if (!document.url) continue;
    add({
      materialNumber: document.material_number,
      field: `documents.${document.document_type || "document"}`,
      value: String(document.url),
    });
  }

  for (const item of retrieval?.catalog_listing?.items ?? []) {
    if (!item.material_number) continue;
    const label = item.model ?? item.product_name ?? item.description;
    const hierarchy = [item.parent_family, item.family].filter(Boolean).join(" > ");
    add({
      materialNumber: item.material_number,
      field: "catalog_listing.identity",
      value: [label, item.description && item.description !== label ? item.description : null, hierarchy].filter(Boolean).join(" — "),
    });
  }

  return [...grouped.values()].map(({ values, ...item }) => ({
    ...item,
    value: values.join("; "),
  }));
}

/**
 * Convert the richer server-side retrieval result into the compact, explicitly
 * citable object sent to the answer model. Full record_json values never cross
 * this boundary.
 */
export function buildMasterGroundingBundle(retrieval, scopeOverrides = {}) {
  const prompt = retrieval?.prompt_context ?? {};
  const catalogScope = prompt.catalog_scope ?? {};
  const materials = new Map((prompt.materials ?? []).map((material) => [String(material.material_number), material]));
  for (const item of prompt.catalog_listing?.items ?? []) {
    if (item.material_number) materials.set(String(item.material_number), item);
  }
  const sourceFile = catalogScope.source_file ?? "Loaded master catalog";
  const baseEvidence = Array.isArray(prompt.evidence) ? prompt.evidence : [];
  const supplementalEvidence = groupSupplementalEvidence(retrieval, materials, sourceFile);
  const evidenceFields = [];
  const evidenceKeys = new Set();
  for (const item of [...baseEvidence, ...supplementalEvidence]) {
    const materialNumber = String(item?.material_number ?? "").trim();
    const field = String(item?.field ?? "").trim();
    const value = asText(item?.value).trim();
    if (!materialNumber || !field || !value) continue;
    const key = `${materialNumber}|${field}`;
    if (evidenceKeys.has(key)) continue;
    evidenceKeys.add(key);
    evidenceFields.push({
      material_number: materialNumber,
      model_or_item: String(item.model_or_item ?? materialLabel(materials.get(materialNumber), materialNumber)),
      field,
      value,
      source_file: String(item.source_file ?? sourceFile),
      ...(item.source_sheet ? { source_sheet: item.source_sheet } : {}),
      ...(item.source_row ? { source_row: item.source_row } : {}),
      ...(item.source_header ? { source_header: item.source_header } : {}),
      ...(item.source_column ? { source_column: item.source_column } : {}),
    });
    if (evidenceFields.length >= MAX_GROUNDING_EVIDENCE) break;
  }

  const allowedMaterials = new Set((prompt.materials ?? []).map((material) => String(material.material_number)));
  for (const match of prompt.exact_matches ?? []) {
    if (match.material?.material_number) allowedMaterials.add(String(match.material.material_number));
    for (const candidate of match.candidates ?? []) {
      if (candidate.material_number) allowedMaterials.add(String(candidate.material_number));
    }
  }
  for (const item of prompt.catalog_listing?.items ?? []) {
    if (item.material_number) allowedMaterials.add(String(item.material_number));
  }
  for (const relationship of retrieval?.relationships ?? []) {
    if (relationship.source_material_number) allowedMaterials.add(String(relationship.source_material_number));
    if (relationship.target_material_number) allowedMaterials.add(String(relationship.target_material_number));
  }
  for (const document of retrieval?.documents ?? []) {
    if (document.material_number) allowedMaterials.add(String(document.material_number));
  }

  const compactPrompt = { ...prompt };
  delete compactPrompt.evidence;
  const strategy = retrieval?.retrieval?.strategy ?? prompt.retrieval_strategy ?? "none";
  const semanticStatus = retrieval?.retrieval?.semantic?.status ?? "not_configured";
  return {
    ...compactPrompt,
    request_status: retrieval?.status ?? "not_ready",
    catalog_scope: {
      ...catalogScope,
      materials: Number(catalogScope.material_count) || 0,
      chunks: Number(catalogScope.chunk_count) || 0,
      relationships: Number(catalogScope.relationship_count) || 0,
      documents: Number(catalogScope.document_count) || 0,
      ...scopeOverrides,
    },
    retrieval: {
      strategy,
      vectorize_status: semanticStatus,
      result_count: Array.isArray(prompt.chunks) ? prompt.chunks.length : 0,
      lexical_status: retrieval?.retrieval?.lexical?.status ?? "not_configured",
      semantic_status: semanticStatus,
      numeric_status: retrieval?.retrieval?.numeric?.status ?? "skipped",
      fused_candidates: Number(retrieval?.retrieval?.fused_candidates) || 0,
    },
    evidence_fields: evidenceFields,
    allowed_material_numbers: [...allowedMaterials],
  };
}

/** Only return evidence values that were already present in the model prompt. */
export function hydrateMasterEvidenceItems(items, groundingBundle) {
  if (!Array.isArray(items)) return [];
  const available = new Map((groundingBundle?.evidence_fields ?? []).map((item) => [
    `${String(item.material_number)}|${String(item.field)}`,
    item,
  ]));
  const hydrated = [];
  const seen = new Set();
  for (const request of items.slice(0, MAX_GROUNDING_EVIDENCE)) {
    const key = `${String(request?.material_number ?? "").trim()}|${String(request?.field ?? "").trim()}`;
    if (seen.has(key) || !available.has(key)) continue;
    seen.add(key);
    hydrated.push(available.get(key));
  }
  return hydrated;
}
