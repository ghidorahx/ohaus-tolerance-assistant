import assert from "node:assert/strict";
import test from "node:test";
import {
  getSalesVectorizeSeedBatch,
  getSalesVectorizeStatus,
  querySalesVectorize,
  SALES_EMBEDDING_MODEL,
  SALES_VECTORIZE_NAMESPACE,
  seedSalesVectorizeBatch,
} from "../lib/sales-vectorize.mjs";

function embedding(value = 0.1) {
  return Array.from({ length: 768 }, () => value);
}

test("chunks all generated knowledge documents within the embedding input budget", () => {
  const status = getSalesVectorizeStatus();
  const batch = getSalesVectorizeSeedBatch(0, 24);
  assert.equal(status.source_documents, 87);
  assert.ok(status.vector_records > status.source_documents);
  assert.equal(batch.records.length, 24);
  assert.ok(batch.records.every((record) => record.text.length <= 1_450));
  assert.ok(batch.records.every((record) => record.id.length <= 64));
  assert.ok(batch.records.every((record) => record.metadata.document_id));
});

test("embeds and upserts a bounded Vectorize seed batch with consistent pooling", async () => {
  const calls = [];
  const ai = {
    async run(model, input) {
      calls.push({ model, input });
      return { data: input.text.map(() => embedding()) };
    },
  };
  const index = {
    async upsert(vectors) {
      calls.push({ vectors });
      return { mutationId: "mutation-1" };
    },
  };
  const result = await seedSalesVectorizeBatch({ ai, index, cursor: 0, batchSize: 3 });
  assert.equal(calls[0].model, SALES_EMBEDDING_MODEL);
  assert.equal(calls[0].input.pooling, "cls");
  assert.equal(calls[1].vectors.length, 3);
  assert.ok(calls[1].vectors.every((vector) => vector.namespace === SALES_VECTORIZE_NAMESPACE));
  assert.equal(result.processed, 3);
  assert.equal(result.next_cursor, 3);
  assert.equal(result.mutation_id, "mutation-1");
});

test("queries the catalog namespace without returning vector values", async () => {
  const calls = [];
  const ai = {
    async run(model, input) {
      calls.push({ model, input });
      return { data: [embedding(0.2)] };
    },
  };
  const index = {
    async query(vector, options) {
      calls.push({ vector, options });
      return {
        matches: [{
          id: "family:scout-skx:0",
          score: 0.91,
          metadata: { document_id: "family:scout-skx" },
        }],
      };
    },
  };
  const result = await querySalesVectorize({ question: "stackable classroom balance", ai, index });
  assert.equal(calls[0].input.pooling, "cls");
  assert.equal(calls[1].options.namespace, SALES_VECTORIZE_NAMESPACE);
  assert.equal(calls[1].options.returnValues, false);
  assert.equal(calls[1].options.returnMetadata, "all");
  assert.deepEqual(result.matches, [{
    id: "family:scout-skx:0",
    score: 0.91,
    document_id: "family:scout-skx",
  }]);
});
