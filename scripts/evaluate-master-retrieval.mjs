import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  retrievalProfileFingerprintPayload,
  verifyMasterRetrievalProfile,
} from "./verify-master-retrieval-profile.mjs";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function option(name, fallback = "") {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

async function adminRequest(url, token, body, fetchImpl = fetch) {
  const response = await fetchImpl(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json", "x-catalog-admin-token": token },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error ?? `Retrieval evaluation request failed (${response.status}).`);
  return payload;
}

export function returnedMaterials(prompt) {
  const materials = new Set();
  const add = (value) => {
    const normalized = String(value ?? "").trim();
    if (normalized) materials.add(normalized);
  };
  for (const item of prompt?.materials ?? []) add(item.material_number);
  for (const item of prompt?.chunks ?? []) add(item.material_number);
  for (const item of prompt?.evidence ?? []) add(item.material_number);
  for (const match of prompt?.exact_matches ?? []) {
    add(match.material?.material_number);
    for (const candidate of match.candidates ?? []) add(candidate.material_number);
  }
  for (const relationship of prompt?.relationships ?? []) {
    add(relationship.source_material_number);
    add(relationship.target_material_number);
  }
  for (const document of prompt?.documents ?? []) add(document.material_number);
  for (const item of prompt?.catalog_listing?.items ?? []) add(item.material_number);
  for (const match of prompt?.numeric_matches ?? []) add(match.material_number);
  return materials;
}

const IDENTITY_SOURCE_HEADERS = new Set([
  "material number",
  "material description",
  "material description global english",
  "parent family name",
  "family name",
  "trade name",
  "product name",
]);

function normalizedText(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function uniqueStrings(values) {
  return [...new Set((values ?? []).map((value) => String(value ?? "").trim()).filter(Boolean))];
}

function scalarStrings(value, output = [], depth = 0) {
  if (value === null || value === undefined || depth > 5) return output;
  if (["string", "number", "bigint"].includes(typeof value)) {
    const text = String(value).trim();
    if (text) output.push(text);
    return output;
  }
  if (Array.isArray(value)) {
    for (const item of value) scalarStrings(item, output, depth + 1);
    return output;
  }
  if (typeof value === "object") {
    for (const item of Object.values(value)) scalarStrings(item, output, depth + 1);
  }
  return output;
}

function relevantMaterialRows(rows, expectedMaterials) {
  const expected = new Set(expectedMaterials);
  return (rows ?? []).filter((row) => {
    const material = String(row?.material_number ?? "").trim();
    return !material || expected.has(material);
  });
}

function containsComparableText(values, expected) {
  const needle = normalizedText(expected);
  return Boolean(needle) && values.some((value) => normalizedText(value).includes(needle));
}

function containsIdentifier(values, expected) {
  const needle = normalizedText(expected);
  if (!needle) return false;
  return values.some((value) => {
    const haystack = normalizedText(value);
    return haystack === needle || haystack.startsWith(`${needle} `)
      || haystack.endsWith(` ${needle}`) || haystack.includes(` ${needle} `);
  });
}

function exactComparableText(left, right) {
  return normalizedText(left) === normalizedText(right);
}

function setDifference(left, right) {
  const rightSet = new Set(right);
  return [...new Set(left)].filter((value) => !rightSet.has(value));
}

function expectedTechnicalValues(evaluation) {
  const requiredHeaders = uniqueStrings(evaluation.expected?.source_fields)
    .filter((header) => !IDENTITY_SOURCE_HEADERS.has(normalizedText(header)));
  const assertions = [];
  for (const evidence of evaluation.expected?.evidence ?? []) {
    const materialNumber = String(evidence?.material_number ?? "").trim();
    for (const header of requiredHeaders) {
      const expectedValue = evidence?.fields?.[header];
      if (materialNumber && String(expectedValue ?? "").trim()) {
        assertions.push({ material_number: materialNumber, source_field: header, expected_value: String(expectedValue) });
      }
    }
  }
  return assertions;
}

function technicalValueRequirements(evaluation, prompt) {
  if (!["technical_field", "numeric_filter"].includes(evaluation.category)) return [];
  const returnedEvidence = prompt?.evidence ?? [];
  return expectedTechnicalValues(evaluation).flatMap((assertion) => {
    const returnedValues = returnedEvidence
      .filter((item) => String(item?.material_number ?? "").trim() === assertion.material_number)
      .filter((item) => normalizedText(item?.source_header) === normalizedText(assertion.source_field))
      .map((item) => String(item?.value ?? "").trim())
      .filter(Boolean);
    return returnedValues.some((value) => exactComparableText(value, assertion.expected_value))
      ? []
      : [{ ...assertion, returned_values: uniqueStrings(returnedValues).slice(0, 4) }];
  });
}

function numericConstraintMatches(actual, expected) {
  const actualValue = Number(actual?.value);
  const expectedValue = Number(expected?.value);
  const epsilon = Math.max(Math.abs(expectedValue) * 1e-9, 1e-12);
  return String(actual?.field ?? "") === String(expected?.field ?? "")
    && String(actual?.comparator ?? "") === String(expected?.comparator ?? "")
    && String(actual?.unit ?? "") === String(expected?.unit ?? "")
    && Number.isFinite(actualValue)
    && Number.isFinite(expectedValue)
    && Math.abs(actualValue - expectedValue) <= epsilon;
}

function resultAssertionRequirements(evaluation, prompt, responseStatus, diagnostics) {
  const assertions = evaluation.expected?.result_assertions;
  if (!assertions || Object.keys(assertions).length === 0) return {};
  const missing = {};
  const listing = prompt?.catalog_listing;
  const requiresListing = Boolean(
    assertions.catalog_listing_kind
    || assertions.category_level
    || assertions.category_name
    || Array.isArray(assertions.exact_listing_material_numbers),
  );
  if (requiresListing && !listing) missing.missing_catalog_listing = true;
  if (listing && assertions.catalog_listing_kind && listing.kind !== assertions.catalog_listing_kind) {
    missing.catalog_listing_kind = { expected: assertions.catalog_listing_kind, returned: listing.kind ?? null };
  }
  if (listing && assertions.category_level && listing.category?.level !== assertions.category_level) {
    missing.category_level = { expected: assertions.category_level, returned: listing.category?.level ?? null };
  }
  if (listing && assertions.category_name && !exactComparableText(listing.category?.name, assertions.category_name)) {
    missing.category_name = { expected: assertions.category_name, returned: listing.category?.name ?? null };
  }

  if (listing && Array.isArray(assertions.exact_listing_material_numbers)) {
    const expectedMaterials = uniqueStrings(assertions.exact_listing_material_numbers).sort();
    const actualMaterials = uniqueStrings((listing.items ?? []).map((item) => item?.material_number)).sort();
    const missingMaterials = setDifference(expectedMaterials, actualMaterials);
    const unexpectedMaterials = setDifference(actualMaterials, expectedMaterials);
    if (missingMaterials.length > 0) missing.missing_listing_materials = missingMaterials;
    if (unexpectedMaterials.length > 0) missing.unexpected_listing_materials = unexpectedMaterials;
    if (Number(listing.total_count) !== expectedMaterials.length) {
      missing.listing_total_count = { expected: expectedMaterials.length, returned: Number(listing.total_count) || 0 };
    }
    if (listing.truncated) missing.listing_unexpectedly_truncated = true;
  }

  const expectedConstraints = assertions.numeric_constraints ?? [];
  if (expectedConstraints.length > 0) {
    const remaining = [...(prompt?.numeric_constraints ?? [])];
    const missingConstraints = [];
    for (const expected of expectedConstraints) {
      const index = remaining.findIndex((actual) => numericConstraintMatches(actual, expected));
      if (index < 0) missingConstraints.push(expected);
      else remaining.splice(index, 1);
    }
    if (missingConstraints.length > 0) missing.missing_numeric_constraints = missingConstraints;
    if (remaining.length > 0) missing.unexpected_numeric_constraints = remaining;
  }

  if (evaluation.expected?.answerability === "no_results") {
    if (listing?.status !== "no_results") {
      missing.no_results_listing_status = { expected: "no_results", returned: listing?.status ?? null };
    }
    if (responseStatus !== "no_results" && responseStatus !== "ready") {
      missing.no_results_response_status = { expected: "no_results or ready", returned: responseStatus ?? null };
    }
  }
  if (Array.isArray(assertions.semantic_material_numbers)) {
    const expectedSemantic = uniqueStrings(assertions.semantic_material_numbers);
    const returnedSemantic = uniqueStrings(diagnostics?.semantic_material_numbers);
    const missingSemantic = setDifference(expectedSemantic, returnedSemantic);
    if (diagnostics?.semantic_status !== "ready") {
      missing.semantic_status = { expected: "ready", returned: diagnostics?.semantic_status ?? null };
    }
    if (missingSemantic.length > 0) missing.missing_semantic_materials = missingSemantic;
  }
  return missing;
}

function expectedDocumentUrls(expected) {
  const urls = [];
  for (const evidence of expected?.evidence ?? []) {
    for (const value of Object.values(evidence?.fields ?? {})) {
      for (const text of scalarStrings(value)) {
        if (/^https?:\/\/\S+$/i.test(text)) urls.push(text);
      }
    }
  }
  return uniqueStrings(urls);
}

function normalizedUrl(value) {
  const text = String(value ?? "").trim();
  if (!/^https?:\/\//i.test(text)) return "";
  try {
    return new URL(text).href;
  } catch {
    return text;
  }
}

function returnedDocumentUrls(prompt, expectedMaterials) {
  const values = [];
  for (const document of prompt?.documents ?? []) scalarStrings(document?.url, values);
  for (const evidence of relevantMaterialRows(prompt?.evidence, expectedMaterials)) {
    scalarStrings(evidence?.value, values);
  }
  return new Set(values.map(normalizedUrl).filter(Boolean));
}

function categoryRequirements(evaluation, prompt, expectedMaterials, responseStatus, diagnostics) {
  const missing = {};
  if (evaluation.category === "technical_field") {
    const requiredHeaders = uniqueStrings(evaluation.expected?.source_fields)
      .filter((header) => !IDENTITY_SOURCE_HEADERS.has(normalizedText(header)));
    const returnedHeaders = new Set(
      relevantMaterialRows(prompt?.evidence, expectedMaterials)
        .map((evidence) => normalizedText(evidence?.source_header))
        .filter(Boolean),
    );
    const missingHeaders = requiredHeaders.filter((header) => !returnedHeaders.has(normalizedText(header)));
    if (missingHeaders.length > 0) missing.missing_source_fields = missingHeaders;
  }

  const missingTechnicalValues = technicalValueRequirements(evaluation, prompt);
  if (missingTechnicalValues.length > 0) missing.missing_technical_values = missingTechnicalValues;

  if (evaluation.category === "relationship") {
    const relationshipValues = scalarStrings(prompt?.relationships);
    for (const chunk of relevantMaterialRows(prompt?.chunks, expectedMaterials)) {
      scalarStrings(chunk?.title, relationshipValues);
      scalarStrings(chunk?.content, relationshipValues);
    }
    for (const evidence of relevantMaterialRows(prompt?.evidence, expectedMaterials)) {
      scalarStrings(evidence?.value, relationshipValues);
    }
    const missingMaterials = uniqueStrings(evaluation.expected?.related_material_numbers)
      .filter((material) => !containsIdentifier(relationshipValues, material));
    const missingValues = uniqueStrings(evaluation.expected?.related_values)
      .filter((value) => !containsComparableText(relationshipValues, value));
    if (missingMaterials.length > 0) missing.missing_related_material_numbers = missingMaterials;
    if (missingValues.length > 0) missing.missing_related_values = missingValues;
  }

  if (evaluation.category === "document_link") {
    const returnedUrls = returnedDocumentUrls(prompt, expectedMaterials);
    const missingUrls = expectedDocumentUrls(evaluation.expected)
      .filter((url) => !returnedUrls.has(normalizedUrl(url)));
    if (missingUrls.length > 0) missing.missing_document_urls = missingUrls;
  }
  return {
    ...missing,
    ...resultAssertionRequirements(evaluation, prompt, responseStatus, diagnostics),
  };
}

function evaluateCase(evaluation, prompt, responseStatus, diagnostics) {
  const actualMaterials = returnedMaterials(prompt);
  const expectedMaterials = uniqueStrings(evaluation.expected?.material_numbers);
  const missingMaterials = expectedMaterials.filter((material) => !actualMaterials.has(material));
  const categoryMissing = categoryRequirements(evaluation, prompt, expectedMaterials, responseStatus, diagnostics);
  const missing = {
    ...(missingMaterials.length > 0 ? { missing_materials: missingMaterials } : {}),
    ...categoryMissing,
  };
  const answerability = String(evaluation.expected?.answerability ?? "");
  return {
    passed: ["grounded", "no_results"].includes(answerability)
      && (answerability === "no_results" || expectedMaterials.length > 0)
      && Object.keys(missing).length === 0,
    expected: expectedMaterials,
    returned: [...actualMaterials].slice(0, 24),
    missing,
  };
}

function rawSha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalize(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function normalizedLimit(value) {
  const limit = Number(value);
  return Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 0;
}

export async function evaluateMasterRetrieval({
  url,
  token,
  versionId,
  fixture,
  fixtureRaw,
  requiredProfile = null,
  requestedLimit = 0,
  fetchImpl = fetch,
  now = () => new Date().toISOString(),
  log = console.log,
}) {
  if (!token?.trim()) throw new Error("CATALOG_ADMIN_TOKEN is required.");
  if (!Array.isArray(fixture?.cases)) throw new Error("Evaluation fixture cases are required.");

  const fixtureSha256 = rawSha256(fixtureRaw);
  const fixtureSchemaVersion = String(fixture.schema_version ?? "").trim();
  const sourceSha256 = String(fixture.source?.sha256 ?? "").trim();
  if (!fixtureSchemaVersion) throw new Error("Evaluation fixture schema_version is required.");
  if (!/^[a-f0-9]{64}$/.test(sourceSha256)) throw new Error("Evaluation fixture source.sha256 is invalid.");

  const requiredCases = fixture.cases.filter((item) => item.expected?.answerability !== "unsupported_live_data");
  if (requiredCases.length === 0) throw new Error("Evaluation fixture must contain at least one required case.");
  let retrievalProfileSha256 = null;
  if (requiredProfile) {
    const expected = {
      fixtureSha256: String(requiredProfile.fixture_sha256 ?? "").trim().toLowerCase(),
      fixtureSchemaVersion: String(requiredProfile.fixture_schema_version ?? "").trim(),
      sourceSha256: String(requiredProfile.source_sha256 ?? "").trim().toLowerCase(),
      fixtureCaseCount: Number(requiredProfile.fixture_case_count),
      retrievalProfileSha256: String(requiredProfile.retrieval_profile_sha256 ?? "").trim().toLowerCase(),
    };
    const computedProfileSha256 = rawSha256(canonicalize(retrievalProfileFingerprintPayload(requiredProfile)));
    const matches = fixtureSha256 === expected.fixtureSha256
      && fixtureSchemaVersion === expected.fixtureSchemaVersion
      && sourceSha256 === expected.sourceSha256
      && requiredCases.length === expected.fixtureCaseCount
      && /^[a-f0-9]{64}$/.test(expected.retrievalProfileSha256)
      && computedProfileSha256 === expected.retrievalProfileSha256;
    if (!matches) {
      throw new Error("The evaluation fixture does not match the deployed activation profile. Rebuild both files from the same workbook before evaluating.");
    }
    retrievalProfileSha256 = expected.retrievalProfileSha256;
  }
  const limit = normalizedLimit(requestedLimit);
  const cases = limit > 0 ? requiredCases.slice(0, limit) : requiredCases;
  const unsupportedCaseCount = fixture.cases.filter(
    (item) => item.expected?.answerability === "unsupported_live_data",
  ).length;

  const failures = [];
  const categoryCounts = new Map();
  const categoryPasses = new Map();
  const started = performance.now();
  for (const [index, evaluation] of cases.entries()) {
    const payload = await adminRequest(url, token, {
      action: "retrieve",
      version_id: versionId,
      question: evaluation.query,
    }, fetchImpl);
    const result = evaluateCase(
      evaluation,
      payload.prompt_context,
      payload.status,
      payload.evaluation_diagnostics,
    );
    categoryCounts.set(evaluation.category, (categoryCounts.get(evaluation.category) ?? 0) + 1);
    categoryPasses.set(evaluation.category, (categoryPasses.get(evaluation.category) ?? 0) + Number(result.passed));
    if (!result.passed) {
      failures.push({
        id: evaluation.id,
        category: evaluation.category,
        expected: result.expected,
        returned: result.returned,
        ...result.missing,
      });
    }
    if ((index + 1) % 10 === 0 || index + 1 === cases.length) {
      log(`Evaluated ${index + 1}/${cases.length}; ${failures.length} misses.`);
    }
  }

  const passedCount = cases.length - failures.length;
  const complete = cases.length === requiredCases.length;
  const status = failures.length > 0 ? "failed" : complete ? "passed" : "incomplete";
  const evaluatedAt = now();
  const summary = {
    version_id: versionId,
    fixture_sha256: fixtureSha256,
    fixture_schema_version: fixtureSchemaVersion,
    source_sha256: sourceSha256,
    retrieval_profile_sha256: retrievalProfileSha256,
    fixture_case_count: requiredCases.length,
    raw_fixture_case_count: fixture.cases.length,
    unsupported_case_count: unsupportedCaseCount,
    requested_limit: limit || null,
    evaluated: cases.length,
    passed: passedCount,
    failed: failures.length,
    status,
    evaluated_at: evaluatedAt,
    pass_rate: cases.length ? Number((passedCount / cases.length).toFixed(4)) : 0,
    elapsed_ms: Math.round(performance.now() - started),
    category_evaluated: Object.fromEntries([...categoryCounts].sort()),
    category_passes: Object.fromEntries([...categoryPasses].sort()),
    failures,
  };
  const failureListFields = [
    "expected",
    "returned",
    "missing_materials",
    "missing_source_fields",
    "missing_related_material_numbers",
    "missing_related_values",
    "missing_document_urls",
    "missing_technical_values",
    "missing_listing_materials",
    "unexpected_listing_materials",
    "missing_numeric_constraints",
    "unexpected_numeric_constraints",
    "missing_semantic_materials",
  ];
  const failureSample = failures.slice(0, 8).map((failure) => {
    const compact = { ...failure };
    for (const field of failureListFields) {
      if (!Array.isArray(failure[field])) continue;
      compact[field] = failure[field].slice(0, 8);
      compact[`${field}_truncated`] = failure[field].length > 8;
    }
    return compact;
  });
  const persistedDetails = {
    ...summary,
    failures: failureSample,
    failure_sample_count: failureSample.length,
    failures_truncated: failures.length > failureSample.length,
  };

  const recorded = await adminRequest(url, token, {
    action: "record_evaluation",
    version_id: versionId,
    fixture_sha256: fixtureSha256,
    fixture_schema_version: fixtureSchemaVersion,
    source_sha256: sourceSha256,
    retrieval_profile_sha256: retrievalProfileSha256,
    fixture_case_count: requiredCases.length,
    evaluated_count: cases.length,
    passed_count: passedCount,
    failed_count: failures.length,
    status,
    evaluated_at: evaluatedAt,
    details: persistedDetails,
  }, fetchImpl);

  return { summary, recorded };
}

export async function main() {
  const token = process.env.CATALOG_ADMIN_TOKEN?.trim();
  if (!token) throw new Error("CATALOG_ADMIN_TOKEN is required.");

  const manifestPath = path.resolve(option("--manifest", path.join(appRoot, "data/master-catalog-manifest.json")));
  const fixturePath = path.resolve(option("--fixture", path.join(appRoot, "data/master-retrieval-eval.json")));
  const profilePath = path.resolve(option("--profile", path.join(appRoot, "data/master-retrieval-eval-profile.json")));
  const url = option("--url", process.env.CATALOG_ADMIN_URL ?? "https://support.ghidorahx.workers.dev/api/sales");
  const [manifestText, fixtureRaw, profileText] = await Promise.all([
    readFile(manifestPath, "utf8"),
    readFile(fixturePath),
    readFile(profilePath, "utf8"),
  ]);
  const manifest = JSON.parse(manifestText);
  const fixture = JSON.parse(fixtureRaw.toString("utf8"));
  const requiredProfile = JSON.parse(profileText);
  await verifyMasterRetrievalProfile({ appRoot, fixturePath, profilePath });
  const versionId = option("--version", manifest.version_id);
  const requestedLimit = option("--limit", "0");

  const { summary } = await evaluateMasterRetrieval({
    url,
    token,
    versionId,
    fixture,
    fixtureRaw,
    requiredProfile,
    requestedLimit,
  });
  console.log(JSON.stringify(summary, null, 2));
  return summary.failed > 0 ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const exitCode = await main();
    if (exitCode !== 0) process.exitCode = exitCode;
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
