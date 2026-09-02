import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { evaluateMasterRetrieval } from "../scripts/evaluate-master-retrieval.mjs";
import {
  retrievalProfileFingerprintPayload,
  verifyMasterRetrievalProfile,
} from "../scripts/verify-master-retrieval-profile.mjs";

const fixture = JSON.parse(
  await readFile(new URL("../data/master-retrieval-eval.json", import.meta.url), "utf8"),
);
const fixtureRaw = await readFile(new URL("../data/master-retrieval-eval.json", import.meta.url));
const fixtureProfile = JSON.parse(
  await readFile(new URL("../data/master-retrieval-eval-profile.json", import.meta.url), "utf8"),
);

const EXPECTED_SOURCE_SHA256 = "5651c886837bf7b6817d829273d3c9a608658cd107798a9d206d01ad404950bb";
const EXPECTED_PARENT_MATERIAL_SHA256 = "3775602079c3c96ef5a989a7badbce90342b5c78bc86e2d823fd4b78fb22b5fe";
const EXPECTED_CATEGORIES = {
  category_filter: 1,
  document_link: 8,
  exact_material: 48,
  model_alias: 15,
  no_results: 1,
  numeric_filter: 3,
  relationship: 10,
  semantic_discovery: 3,
  technical_field: 20,
  unsupported_live_data: 6,
};
const EXPECTED_SIX_DIGIT_MATERIALS = ["214642", "923345", "923389"];
const EXPECTED_TECHNICAL_FIELDS = [
  "Maximum Capacity {metric}",
  "Readability {metric}",
  "Stabilization Time",
  "Battery Life",
  "Power",
  "Legal for Trade",
  "IP Rating",
  "Maximum Speed",
  "Speed Range",
  "Temperature Range {metric}",
  "Measurement Range",
  "pH measuring range",
  "Conductivity measuring range",
  "Accuracy",
  "Calibration Certificate",
  "Weight Tolerance",
  "NTEP Approval",
  "Pan Size {Width} {metric}",
  "Platform Size {Length} {metric}",
  "Working Environment {metric}",
];
const EXPECTED_RELATIONSHIP_FIELDS = [
  "Relationship / Accessories",
  "Relationship / Cross Selling",
  "Relationship / Services",
  "Relationship / Spare Parts",
  "Relationship / Upsellings",
  "Relationship / Replacements",
  "Compatible Models",
  "Rotor Compatibility",
  "Accessories Included",
  "Sample Vials Compatibility",
];
const EXPECTED_DOCUMENT_FIELDS = [
  "EN Data Sheets 1",
  "EN Data Sheets 2",
  "EN Data Sheets 3",
  "EN User Guide 1",
  "EN User Guide 2",
  "EN Manuals 1",
  "EN Manuals 2",
];

function canonicalize(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash("sha256").update(canonicalize(value)).digest("hex");
}

function categoryCounts(cases) {
  return Object.fromEntries(
    [...cases.reduce((counts, entry) => counts.set(entry.category, (counts.get(entry.category) ?? 0) + 1), new Map())]
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

function syntheticFixtureRaw() {
  return Buffer.from(`${JSON.stringify({
    schema_version: "test-v1",
    source: { sha256: "a".repeat(64) },
    cases: [
      {
        id: "grounded-one",
        category: "exact_material",
        query: "first",
        expected: { answerability: "grounded", material_numbers: ["10000001"] },
      },
      {
        id: "grounded-two",
        category: "model_alias",
        query: "second",
        expected: { answerability: "grounded", material_numbers: ["20000002"] },
      },
      {
        id: "unsupported-one",
        category: "unsupported_live_data",
        query: "live price",
        expected: { answerability: "unsupported_live_data", material_numbers: [] },
      },
    ],
  }, null, 2)}\n`);
}

function fixtureRawForCases(cases, sourceSha256 = "b".repeat(64)) {
  return Buffer.from(`${JSON.stringify({
    schema_version: "test-v1",
    source: { sha256: sourceSha256 },
    cases,
  }, null, 2)}\n`);
}

function evaluationFetch(returnedByQuestion, calls) {
  return async (url, options) => {
    const body = JSON.parse(options.body);
    calls.push({ url, options, body });
    if (body.action === "record_evaluation") {
      return { ok: true, status: 200, async json() { return { recorded: true }; } };
    }
    const returned = returnedByQuestion[body.question];
    const promptContext = typeof returned === "string"
      ? { materials: [{ material_number: returned }] }
      : returned ?? {};
    return {
      ok: true,
      status: 200,
      async json() {
        return { prompt_context: promptContext };
      },
    };
  };
}

test("pins the exact master workbook and deterministic evaluation manifest", async () => {
  assert.equal(fixture.schema_version, "2.0.0");
  assert.deepEqual(fixture.source, {
    file: "MMMDF_EN_US_20260605_AI_Organized 2.xlsx",
    sheet: "Product_Catalog_AI",
    sha256: EXPECTED_SOURCE_SHA256,
    rows: 6_407,
    columns: 428,
    selection_rule: "Use Product_Catalog_AI only; exclude Raw_Data and blank Parent Family Name values.",
  });
  assert.ok(fixture.manifest.case_count >= 80 && fixture.manifest.case_count <= 120);
  assert.equal(fixture.cases.length, fixture.manifest.case_count);
  assert.deepEqual(categoryCounts(fixture.cases), EXPECTED_CATEGORIES);
  assert.deepEqual(fixture.manifest.categories, EXPECTED_CATEGORIES);
  assert.equal(fixture.manifest.grounded_case_count, 108);
  assert.equal(fixture.manifest.required_case_count, 109);
  assert.equal(fixture.manifest.unsupported_case_count, 6);
  assert.equal(new Set(fixture.cases.map((entry) => entry.id)).size, fixture.cases.length);
  assert.equal(fixtureProfile.profile_version, "2.0.0");
  assert.equal(fixtureProfile.fingerprint_schema_version, "1.0.0");
  assert.equal(fixtureProfile.fixture_file, "master-retrieval-eval.json");
  assert.equal(fixtureProfile.fixture_sha256, createHash("sha256").update(fixtureRaw).digest("hex"));
  assert.equal(fixtureProfile.fixture_schema_version, fixture.schema_version);
  assert.equal(fixtureProfile.source_sha256, EXPECTED_SOURCE_SHA256);
  assert.equal(fixtureProfile.fixture_case_count, 109);
  assert.equal(fixtureProfile.raw_fixture_case_count, 115);
  assert.equal(fixtureProfile.unsupported_case_count, 6);
  assert.match(fixtureProfile.retrieval_build.retrieval_code_sha256, /^[a-f0-9]{64}$/);
  assert.equal(fixtureProfile.retrieval_build.embedding.model, "@cf/baai/bge-small-en-v1.5");
  assert.equal(fixtureProfile.retrieval_build.embedding.dimensions, 384);
  assert.equal(fixtureProfile.retrieval_build.vectorize.index_name, "ohaus-master-catalog-fast-v1");
  assert.equal(fixtureProfile.retrieval_build.vectorize.metric, "cosine");
  assert.equal(
    fixtureProfile.retrieval_profile_sha256,
    sha256(retrievalProfileFingerprintPayload(fixtureProfile)),
  );
  await verifyMasterRetrievalProfile();
});

test("covers every parent family with a stable exact material lookup", () => {
  const parentCases = fixture.cases.filter(
    (entry) => entry.category === "exact_material" && entry.subcategory === "parent_family_lookup",
  );
  const parentNames = parentCases.map((entry) => entry.coverage_key).sort((left, right) => left.localeCompare(right));
  const manifestParents = [...fixture.manifest.parent_families].sort((left, right) => left.localeCompare(right));

  assert.equal(parentCases.length, 46);
  assert.equal(fixture.manifest.parent_family_count, 46);
  assert.deepEqual(parentNames, manifestParents);
  assert.equal(sha256(fixture.manifest.exact_parent_family_materials), EXPECTED_PARENT_MATERIAL_SHA256);
  assert.equal(fixture.manifest.exact_parent_family_materials_sha256, EXPECTED_PARENT_MATERIAL_SHA256);

  const materialByParent = new Map(
    fixture.manifest.exact_parent_family_materials.map((entry) => [entry.parent_family, entry.material_number]),
  );
  assert.equal(materialByParent.get("Portable Balances"), "30253005");
  assert.equal(materialByParent.get("Spare Parts"), "214642");
  assert.equal(materialByParent.get("Turbidimeters"), "30853395");
});

test("keeps six-digit IDs and grounds every answerable case in source fields", () => {
  assert.deepEqual(fixture.manifest.six_digit_material_numbers, EXPECTED_SIX_DIGIT_MATERIALS);
  const exactMaterials = new Set(
    fixture.cases
      .filter((entry) => entry.category === "exact_material")
      .flatMap((entry) => entry.expected.material_numbers),
  );
  for (const material of EXPECTED_SIX_DIGIT_MATERIALS) assert.ok(exactMaterials.has(material));

  const groundedCases = fixture.cases.filter((entry) => entry.expected.answerability === "grounded");
  const manifestMaterials = new Set(fixture.manifest.grounded_material_numbers);
  const groundedMaterials = new Set();
  for (const entry of groundedCases) {
    assert.equal(entry.expected.answerability, "grounded", entry.id);
    assert.ok(entry.expected.material_numbers.length > 0, entry.id);
    assert.ok(entry.expected.parent_families.length > 0, entry.id);
    assert.ok(entry.expected.families.length > 0, entry.id);
    assert.ok(entry.expected.source_fields.length > 0, entry.id);
    assert.ok(entry.expected.evidence.length > 0, entry.id);

    for (const material of entry.expected.material_numbers) {
      assert.match(material, /^\d{6,8}$/, entry.id);
      groundedMaterials.add(material);
      assert.ok(manifestMaterials.has(material), entry.id);
    }
    for (const evidence of entry.expected.evidence) {
      assert.ok(entry.expected.material_numbers.includes(evidence.material_number), entry.id);
      assert.ok(Number.isInteger(evidence.source_row) && evidence.source_row >= 2, entry.id);
      assert.equal(evidence.fields["Material Number"], evidence.material_number, entry.id);
      for (const field of entry.expected.source_fields) {
        assert.equal(typeof evidence.fields[field], "string", `${entry.id}: ${field}`);
        assert.ok(evidence.fields[field].length > 0, `${entry.id}: ${field}`);
      }
    }
  }
  assert.deepEqual([...groundedMaterials].sort(), [...manifestMaterials].sort());
});

test("covers model aliases and twenty paraphrased technical fields", () => {
  const modelCases = fixture.cases.filter((entry) => entry.category === "model_alias");
  assert.equal(modelCases.filter((entry) => entry.subcategory === "alternative_model").length, 2);
  assert.equal(modelCases.filter((entry) => entry.subcategory === "trade_name_normalization").length, 13);
  assert.ok(
    modelCases.every((entry) => entry.expected.source_fields.includes("Trade Name")
      || entry.expected.source_fields.some((field) => field.startsWith("Alternative Model_"))),
  );

  const technicalCases = fixture.cases.filter((entry) => entry.category === "technical_field");
  assert.deepEqual(fixture.manifest.technical_fields, EXPECTED_TECHNICAL_FIELDS);
  assert.deepEqual(technicalCases.map((entry) => entry.coverage_key), EXPECTED_TECHNICAL_FIELDS);
  assert.ok(technicalCases.every((entry) => entry.expected.source_fields.includes(entry.coverage_key)));
  assert.ok(technicalCases.every((entry) => entry.expected.evidence[0].fields[entry.coverage_key]));
});

test("covers semantic discovery, exact category listings, numeric ranges, and a required empty result", () => {
  const semanticCases = fixture.cases.filter((entry) => entry.category === "semantic_discovery");
  assert.equal(semanticCases.length, 3);
  assert.ok(semanticCases.every((entry) => (
    entry.expected.result_assertions.semantic_material_numbers[0]
      === entry.expected.material_numbers[0]
  )));

  const categoryCase = fixture.cases.find((entry) => entry.category === "category_filter");
  assert.ok(categoryCase);
  assert.deepEqual(categoryCase.expected.result_assertions.exact_listing_material_numbers, [
    "30428204", "30428205", "30428206", "30428207",
  ]);

  const numericCases = fixture.cases.filter((entry) => entry.category === "numeric_filter");
  assert.equal(numericCases.length, 3);
  const range = numericCases.find((entry) => entry.id === "numeric-scout-capacity-range-400g-700g");
  assert.deepEqual(range.expected.result_assertions.numeric_constraints, [
    { field: "capacity", comparator: "at_least", value: 400, unit: "g" },
    { field: "capacity", comparator: "at_most", value: 700, unit: "g" },
  ]);
  assert.deepEqual(range.expected.result_assertions.exact_listing_material_numbers, [
    "30253008", "30253009", "30253012", "30253013",
  ]);

  const noResults = fixture.cases.find((entry) => entry.category === "no_results");
  assert.ok(noResults);
  assert.equal(noResults.expected.answerability, "no_results");
  assert.deepEqual(noResults.expected.result_assertions.exact_listing_material_numbers, []);
});

test("covers relationship targets and every English document-link field", () => {
  const relationshipCases = fixture.cases.filter((entry) => entry.category === "relationship");
  assert.deepEqual(fixture.manifest.relationship_fields, EXPECTED_RELATIONSHIP_FIELDS);
  assert.deepEqual(relationshipCases.map((entry) => entry.coverage_key), EXPECTED_RELATIONSHIP_FIELDS);
  assert.ok(relationshipCases.every((entry) => entry.expected.source_fields.includes(entry.coverage_key)));
  assert.ok(relationshipCases.slice(0, 6).every((entry) => entry.expected.related_material_numbers.length > 0));
  assert.ok(relationshipCases.slice(6).every((entry) => entry.expected.related_values.length > 0));

  const documentCases = fixture.cases.filter((entry) => entry.category === "document_link");
  assert.deepEqual(fixture.manifest.document_fields, EXPECTED_DOCUMENT_FIELDS);
  assert.equal(documentCases.length, EXPECTED_DOCUMENT_FIELDS.length + 1);
  for (const field of EXPECTED_DOCUMENT_FIELDS) {
    const entry = documentCases.find((candidate) => candidate.coverage_key === field);
    assert.ok(entry, field);
    assert.match(entry.expected.evidence[0].fields[field], /^https?:\/\//, field);
  }
  const combined = documentCases.find((entry) => entry.coverage_key === "all_english_documents");
  assert.ok(combined);
  assert.ok(combined.expected.source_fields.filter((field) => EXPECTED_DOCUMENT_FIELDS.includes(field)).length >= 2);
});

test("requires abstention for live price and inventory questions", () => {
  const unsupportedCases = fixture.cases.filter((entry) => entry.category === "unsupported_live_data");
  assert.deepEqual(
    unsupportedCases.map((entry) => entry.subcategory),
    ["live_price", "inventory_quantity", "live_lead_time", "current_discount", "order_status", "future_restock"],
  );
  for (const entry of unsupportedCases) {
    assert.match(entry.anchor_material_number, /^\d{6,8}$/);
    assert.equal(entry.expected.answerability, "unsupported_live_data");
    assert.deepEqual(entry.expected.material_numbers, []);
    assert.deepEqual(entry.expected.source_fields, []);
    assert.deepEqual(entry.expected.evidence, []);
    assert.match(entry.expected.required_behavior, /do not invent/i);
  }
});

test("hashes the raw fixture and records a complete passing evaluation", async () => {
  const fixtureRaw = syntheticFixtureRaw();
  const fixtureValue = JSON.parse(fixtureRaw.toString("utf8"));
  const calls = [];
  const evaluatedAt = "2026-09-02T12:34:56.000Z";
  const { summary, recorded } = await evaluateMasterRetrieval({
    url: "https://example.invalid/api/sales",
    token: "test-token",
    versionId: "mcv_test",
    fixture: fixtureValue,
    fixtureRaw,
    fetchImpl: evaluationFetch({ first: "10000001", second: "20000002" }, calls),
    now: () => evaluatedAt,
    log() {},
  });

  assert.deepEqual(recorded, { recorded: true });
  assert.equal(summary.fixture_sha256, createHash("sha256").update(fixtureRaw).digest("hex"));
  assert.equal(summary.fixture_case_count, 2);
  assert.equal(summary.raw_fixture_case_count, 3);
  assert.equal(summary.unsupported_case_count, 1);
  assert.equal(summary.status, "passed");
  assert.deepEqual(calls.map(({ body }) => body.action), ["retrieve", "retrieve", "record_evaluation"]);

  const record = calls.at(-1).body;
  assert.deepEqual({
    version_id: record.version_id,
    fixture_sha256: record.fixture_sha256,
    fixture_schema_version: record.fixture_schema_version,
    source_sha256: record.source_sha256,
    fixture_case_count: record.fixture_case_count,
    evaluated_count: record.evaluated_count,
    passed_count: record.passed_count,
    failed_count: record.failed_count,
    status: record.status,
    evaluated_at: record.evaluated_at,
  }, {
    version_id: "mcv_test",
    fixture_sha256: summary.fixture_sha256,
    fixture_schema_version: "test-v1",
    source_sha256: "a".repeat(64),
    fixture_case_count: 2,
    evaluated_count: 2,
    passed_count: 2,
    failed_count: 0,
    status: "passed",
    evaluated_at: evaluatedAt,
  });
  assert.equal(record.details.failure_sample_count, 0);
  assert.equal(record.details.failures_truncated, false);
  assert.deepEqual(record.details.failures, []);
  assert.deepEqual({ ...record.details, failure_sample_count: undefined, failures_truncated: undefined }, {
    ...summary,
    failure_sample_count: undefined,
    failures_truncated: undefined,
  });
  assert.equal(calls.at(-1).options.headers["x-catalog-admin-token"], "test-token");
});

test("requires every expected material number instead of accepting one anchor hit", async () => {
  const fixtureRaw = fixtureRawForCases([
    {
      id: "all-model-materials",
      category: "model_alias",
      query: "find every matching model",
      expected: {
        answerability: "grounded",
        material_numbers: ["10000001", "20000002"],
      },
    },
  ]);
  const calls = [];
  const { summary } = await evaluateMasterRetrieval({
    url: "https://example.invalid/api/sales",
    token: "test-token",
    versionId: "mcv_test",
    fixture: JSON.parse(fixtureRaw.toString("utf8")),
    fixtureRaw,
    fetchImpl: evaluationFetch({
      "find every matching model": {
        materials: [{ material_number: "10000001" }],
      },
    }, calls),
    log() {},
  });

  assert.equal(summary.status, "failed");
  assert.equal(summary.failed, 1);
  assert.deepEqual(summary.failures[0], {
    id: "all-model-materials",
    category: "model_alias",
    expected: ["10000001", "20000002"],
    returned: ["10000001"],
    missing_materials: ["20000002"],
  });
});

test("requires semantic discovery anchors to arrive through the semantic channel", async () => {
  const expected = {
    answerability: "grounded",
    material_numbers: ["83041308"],
    result_assertions: { semantic_material_numbers: ["83041308"] },
  };
  const fixtureRaw = fixtureRawForCases([
    { id: "semantic-empty", category: "semantic_discovery", query: "semantic empty", expected },
    { id: "semantic-grounded", category: "semantic_discovery", query: "semantic grounded", expected },
  ]);
  const calls = [];
  const fetchImpl = async (url, options) => {
    const body = JSON.parse(options.body);
    calls.push({ url, options, body });
    if (body.action === "record_evaluation") {
      return { ok: true, status: 200, async json() { return { recorded: true }; } };
    }
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          status: "ready",
          prompt_context: { materials: [{ material_number: "83041308" }] },
          evaluation_diagnostics: body.question === "semantic grounded"
            ? { semantic_status: "ready", semantic_material_numbers: ["83041308"] }
            : { semantic_status: "ready", semantic_material_numbers: [] },
        };
      },
    };
  };
  const { summary } = await evaluateMasterRetrieval({
    url: "https://example.invalid/api/sales",
    token: "test-token",
    versionId: "mcv_test",
    fixture: JSON.parse(fixtureRaw.toString("utf8")),
    fixtureRaw,
    fetchImpl,
    log() {},
  });

  assert.equal(summary.passed, 1);
  assert.equal(summary.failed, 1);
  assert.deepEqual(summary.failures[0].missing_semantic_materials, ["83041308"]);
});

test("requires exact filtered listings and accepts a proven empty range", async () => {
  const fixtureRaw = fixtureRawForCases([{
    id: "empty-range",
    category: "no_results",
    query: "empty range",
    expected: {
      answerability: "no_results",
      material_numbers: [],
      result_assertions: {
        catalog_listing_kind: "materials_by_category",
        category_level: "family",
        category_name: "Compass™ CR",
        exact_listing_material_numbers: [],
        numeric_constraints: [
          { field: "capacity", comparator: "at_least", value: 700, unit: "g" },
          { field: "capacity", comparator: "at_most", value: 800, unit: "g" },
        ],
      },
    },
  }]);
  const calls = [];
  const { summary } = await evaluateMasterRetrieval({
    url: "https://example.invalid/api/sales",
    token: "test-token",
    versionId: "mcv_test",
    fixture: JSON.parse(fixtureRaw.toString("utf8")),
    fixtureRaw,
    fetchImpl: async (url, options) => {
      const body = JSON.parse(options.body);
      calls.push({ url, options, body });
      if (body.action === "record_evaluation") {
        return { ok: true, status: 200, async json() { return { recorded: true }; } };
      }
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            status: "ready",
            prompt_context: {
              numeric_constraints: [
                { field: "capacity", comparator: "at_least", value: 700, unit: "g" },
                { field: "capacity", comparator: "at_most", value: 800, unit: "g" },
              ],
              catalog_listing: {
                status: "no_results",
                kind: "materials_by_category",
                category: { level: "family", name: "Compass™ CR" },
                total_count: 0,
                returned_count: 0,
                truncated: false,
                items: [],
              },
            },
          };
        },
      };
    },
    log() {},
  });

  assert.equal(summary.status, "passed");
  assert.equal(summary.passed, 1);
});

test("requires technical source headers while ignoring identity-only source fields", async () => {
  const expected = {
    answerability: "grounded",
    material_numbers: ["30000001"],
    source_fields: [
      "Material Number",
      "Material Description (Global English)",
      "Family Name",
      "Readability {metric}",
    ],
    evidence: [{
      material_number: "30000001",
      fields: { "Readability {metric}": "0.1 g" },
    }],
  };
  const fixtureRaw = fixtureRawForCases([
    {
      id: "technical-header-missing",
      category: "technical_field",
      query: "missing technical evidence",
      expected,
    },
    {
      id: "technical-value-wrong",
      category: "technical_field",
      query: "wrong technical value",
      expected,
    },
    {
      id: "technical-header-present",
      category: "technical_field",
      query: "present technical evidence",
      expected,
    },
  ]);
  const calls = [];
  const { summary } = await evaluateMasterRetrieval({
    url: "https://example.invalid/api/sales",
    token: "test-token",
    versionId: "mcv_test",
    fixture: JSON.parse(fixtureRaw.toString("utf8")),
    fixtureRaw,
    fetchImpl: evaluationFetch({
      "missing technical evidence": {
        materials: [{ material_number: "30000001" }],
        evidence: [{
          material_number: "99999999",
          source_header: "Readability {metric}",
          value: "0.1 g",
        }],
      },
      "present technical evidence": {
        materials: [{ material_number: "30000001" }],
        evidence: [{
          material_number: "30000001",
          source_header: "Readability {metric}",
          value: "0.1 g",
        }],
      },
      "wrong technical value": {
        materials: [{ material_number: "30000001" }],
        evidence: [{
          material_number: "30000001",
          source_header: "Readability {metric}",
          value: "0.01 g",
        }],
      },
    }, calls),
    log() {},
  });

  assert.equal(summary.evaluated, 3);
  assert.equal(summary.passed, 1);
  assert.equal(summary.failed, 2);
  assert.deepEqual(summary.category_passes, { technical_field: 1 });
  assert.equal(summary.failures[0].id, "technical-header-missing");
  assert.deepEqual(summary.failures[0].missing_source_fields, ["Readability {metric}"]);
  const wrongValue = summary.failures.find((failure) => failure.id === "technical-value-wrong");
  assert.deepEqual(wrongValue.missing_technical_values, [{
    material_number: "30000001",
    source_field: "Readability {metric}",
    expected_value: "0.1 g",
    returned_values: ["0.01 g"],
  }]);
});

test("requires relationship targets or values in relationship, chunk, or evidence context", async () => {
  const fixtureRaw = fixtureRawForCases([
    {
      id: "relationship-anchor-only",
      category: "relationship",
      query: "anchor only",
      expected: {
        answerability: "grounded",
        material_numbers: ["31000001"],
        related_material_numbers: ["91000001"],
      },
    },
    {
      id: "relationship-structured-target",
      category: "relationship",
      query: "structured relationship",
      expected: {
        answerability: "grounded",
        material_numbers: ["31000002"],
        related_material_numbers: ["91000002"],
      },
    },
    {
      id: "relationship-chunk-value",
      category: "relationship",
      query: "chunk relationship value",
      expected: {
        answerability: "grounded",
        material_numbers: ["31000003"],
        related_values: ["Round Ø25mm"],
      },
    },
    {
      id: "relationship-evidence-value",
      category: "relationship",
      query: "evidence relationship value",
      expected: {
        answerability: "grounded",
        material_numbers: ["31000004"],
        related_values: ["FC5720R"],
      },
    },
  ]);
  const calls = [];
  const { summary } = await evaluateMasterRetrieval({
    url: "https://example.invalid/api/sales",
    token: "test-token",
    versionId: "mcv_test",
    fixture: JSON.parse(fixtureRaw.toString("utf8")),
    fixtureRaw,
    fetchImpl: evaluationFetch({
      "anchor only": {
        materials: [{ material_number: "31000001" }],
      },
      "structured relationship": {
        materials: [{ material_number: "31000002" }],
        relationships: [{
          source_material_number: "31000002",
          target_material_number: "91000002",
        }],
      },
      "chunk relationship value": {
        materials: [{ material_number: "31000003" }],
        chunks: [{
          material_number: "31000003",
          content: "Sample vials compatibility: Round Ø25mm",
        }],
      },
      "evidence relationship value": {
        materials: [{ material_number: "31000004" }],
        evidence: [{
          material_number: "31000004",
          value: "FC5720R",
        }],
      },
    }, calls),
    log() {},
  });

  assert.equal(summary.evaluated, 4);
  assert.equal(summary.passed, 3);
  assert.equal(summary.failed, 1);
  assert.deepEqual(summary.category_passes, { relationship: 3 });
  assert.equal(summary.failures[0].id, "relationship-anchor-only");
  assert.deepEqual(summary.failures[0].missing_related_material_numbers, ["91000001"]);
});

test("requires every expected document URL across documents and evidence", async () => {
  const firstUrl = "https://docs.example.test/data-sheet?id=1";
  const secondUrl = "https://docs.example.test/manual?id=2";
  const expected = {
    answerability: "grounded",
    material_numbers: ["32000001"],
    evidence: [{
      material_number: "32000001",
      fields: {
        "EN Data Sheets 1": firstUrl,
        "EN Manuals 1": secondUrl,
      },
    }],
  };
  const fixtureRaw = fixtureRawForCases([
    {
      id: "document-url-missing",
      category: "document_link",
      query: "missing one document",
      expected,
    },
    {
      id: "document-urls-present",
      category: "document_link",
      query: "both documents",
      expected,
    },
  ]);
  const calls = [];
  const { summary } = await evaluateMasterRetrieval({
    url: "https://example.invalid/api/sales",
    token: "test-token",
    versionId: "mcv_test",
    fixture: JSON.parse(fixtureRaw.toString("utf8")),
    fixtureRaw,
    fetchImpl: evaluationFetch({
      "missing one document": {
        materials: [{ material_number: "32000001" }],
        documents: [{ material_number: "32000001", url: firstUrl }],
      },
      "both documents": {
        materials: [{ material_number: "32000001" }],
        documents: [{ material_number: "32000001", url: firstUrl }],
        evidence: [{ material_number: "32000001", value: secondUrl }],
      },
    }, calls),
    log() {},
  });

  assert.equal(summary.evaluated, 2);
  assert.equal(summary.passed, 1);
  assert.equal(summary.failed, 1);
  assert.deepEqual(summary.category_passes, { document_link: 1 });
  assert.equal(summary.failures[0].id, "document-url-missing");
  assert.deepEqual(summary.failures[0].missing_document_urls, [secondUrl]);
});

test("rejects an evaluation fixture that does not match its activation profile", async () => {
  const syntheticRaw = syntheticFixtureRaw();
  const synthetic = JSON.parse(syntheticRaw.toString("utf8"));
  let called = false;
  await assert.rejects(
    () => evaluateMasterRetrieval({
      url: "https://example.invalid/api/sales",
      token: "test-token",
      versionId: "mcv_test",
      fixture: synthetic,
      fixtureRaw: syntheticRaw,
      requiredProfile: { ...fixtureProfile, source_sha256: "a".repeat(64) },
      fetchImpl: async () => {
        called = true;
        return Response.json({});
      },
      log() {},
    }),
    /does not match the deployed activation profile/i,
  );
  assert.equal(called, false);
});

test("records incomplete smoke runs and failed full evaluations with derived status", async () => {
  const fixtureRaw = syntheticFixtureRaw();
  const fixtureValue = JSON.parse(fixtureRaw.toString("utf8"));

  const limitedCalls = [];
  const limited = await evaluateMasterRetrieval({
    url: "https://example.invalid/api/sales",
    token: "test-token",
    versionId: "mcv_test",
    fixture: fixtureValue,
    fixtureRaw,
    requestedLimit: 1,
    fetchImpl: evaluationFetch({ first: "10000001" }, limitedCalls),
    now: () => "2026-09-02T12:35:00.000Z",
    log() {},
  });
  assert.equal(limited.summary.status, "incomplete");
  assert.equal(limitedCalls.at(-1).body.status, "incomplete");
  assert.equal(limitedCalls.at(-1).body.fixture_case_count, 2);
  assert.equal(limitedCalls.at(-1).body.evaluated_count, 1);

  const failedCalls = [];
  const failed = await evaluateMasterRetrieval({
    url: "https://example.invalid/api/sales",
    token: "test-token",
    versionId: "mcv_test",
    fixture: fixtureValue,
    fixtureRaw,
    fetchImpl: evaluationFetch({ first: "10000001", second: "99999999" }, failedCalls),
    now: () => "2026-09-02T12:36:00.000Z",
    log() {},
  });
  assert.equal(failed.summary.status, "failed");
  assert.equal(failed.summary.failed, 1);
  assert.equal(failedCalls.at(-1).body.status, "failed");
  assert.equal(failedCalls.at(-1).body.failed_count, 1);
  assert.deepEqual(failedCalls.map(({ body }) => body.action), ["retrieve", "retrieve", "record_evaluation"]);
  assert.ok(Buffer.byteLength(JSON.stringify(failedCalls.at(-1).body)) < 12 * 1_024);
});

test("keeps persisted failure details below the administration request budget", async () => {
  const fixtureValue = {
    schema_version: "test-v1",
    source: { sha256: "d".repeat(64) },
    cases: Array.from({ length: 12 }, (_, index) => ({
      id: `failure-${index}`,
      category: "exact_material",
      query: `question-${index}`,
      expected: { answerability: "grounded", material_numbers: [`expected-${index}`] },
    })),
  };
  const fixtureRaw = Buffer.from(`${JSON.stringify(fixtureValue, null, 2)}\n`);
  const calls = [];
  const fetchImpl = async (url, options) => {
    const body = JSON.parse(options.body);
    calls.push({ url, options, body });
    return {
      ok: true,
      status: 200,
      async json() {
        if (body.action === "record_evaluation") return { recorded: true };
        return {
          prompt_context: {
            materials: Array.from({ length: 24 }, (_, index) => ({ material_number: `returned-${index}` })),
          },
        };
      },
    };
  };

  const { summary } = await evaluateMasterRetrieval({
    url: "https://example.invalid/api/sales",
    token: "test-token",
    versionId: "mcv_test",
    fixture: fixtureValue,
    fixtureRaw,
    fetchImpl,
    now: () => "2026-09-02T12:37:00.000Z",
    log() {},
  });
  const recordBody = calls.at(-1).body;

  assert.equal(summary.failures.length, 12);
  assert.equal(recordBody.details.failures.length, 8);
  assert.equal(recordBody.details.failure_sample_count, 8);
  assert.equal(recordBody.details.failures_truncated, true);
  assert.ok(recordBody.details.failures.every((failure) => failure.returned.length === 8));
  assert.ok(recordBody.details.failures.every((failure) => failure.returned_truncated));
  assert.ok(Buffer.byteLength(JSON.stringify(recordBody)) < 12 * 1_024);
});
