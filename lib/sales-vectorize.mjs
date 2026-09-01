import retrievalIndex from "../data/sales-retrieval-index.json" with { type: "json" };

export const SALES_VECTORIZE_INDEX = "ohaus-sales-catalog-v1";
export const SALES_VECTORIZE_BINDING = "SALES_VECTORIZE";
export const SALES_EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";
export const SALES_EMBEDDING_POOLING = "cls";
export const SALES_VECTORIZE_TOP_K = 8;
export const SALES_VECTORIZE_NAMESPACE = `sales-${String(retrievalIndex.source_sha256).slice(0, 24)}`;

const MAX_EMBEDDING_CHARACTERS = 1_450;
const MAX_VECTOR_METADATA_EXCERPT = 900;
const DEFAULT_SEED_BATCH_SIZE = 12;
const MAX_SEED_BATCH_SIZE = 24;

function cleanMarkdown(value) {
  return String(value ?? "")
    .replace(/^---[\s\S]*?---\s*/m, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[#*`>|]/g, " ")
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function splitLongSegment(segment, maximum) {
  const words = String(segment ?? "").split(/\s+/).filter(Boolean);
  const chunks = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length > maximum && current) {
      chunks.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

function documentHeader(document) {
  return [
    document.title,
    document.material_number ? `Material number ${document.material_number}` : "",
    document.model ? `Model ${document.model}` : "",
    document.family ? `Family ${document.family}` : "",
  ].filter(Boolean).join(". ");
}

function chunkDocument(document) {
  const header = documentHeader(document);
  const contentBudget = Math.max(400, MAX_EMBEDDING_CHARACTERS - header.length - 2);
  const paragraphs = cleanMarkdown(document.content)
    .split(/\n\s*\n/)
    .flatMap((paragraph) => splitLongSegment(paragraph, contentBudget));
  const chunks = [];
  let current = "";

  for (const paragraph of paragraphs) {
    const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
    if (candidate.length > contentBudget && current) {
      chunks.push(current);
      current = paragraph;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);
  if (chunks.length === 0) chunks.push(header);

  return chunks.map((chunk, chunkIndex) => ({
    id: `${document.document_id}:${chunkIndex}`,
    text: `${header}\n\n${chunk}`.slice(0, MAX_EMBEDDING_CHARACTERS),
    metadata: {
      document_id: document.document_id,
      document_type: document.document_type,
      title: document.title,
      ...(document.material_number ? { material_number: String(document.material_number) } : {}),
      ...(document.model ? { model: String(document.model) } : {}),
      ...(document.family ? { family: String(document.family) } : {}),
      source_file: document.source_file,
      source_fields: document.source_fields,
      excerpt: cleanMarkdown(chunk).slice(0, MAX_VECTOR_METADATA_EXCERPT),
      chunk_index: chunkIndex,
    },
  }));
}

const vectorRecords = retrievalIndex.documents.flatMap(chunkDocument);

function embeddingVectors(response, expectedCount) {
  const vectors = Array.isArray(response?.data) ? response.data : [];
  if (vectors.length !== expectedCount || vectors.some((vector) => !Array.isArray(vector) || vector.length !== 768)) {
    throw new Error("Workers AI returned an unexpected embedding response.");
  }
  return vectors;
}

export function getSalesVectorizeStatus() {
  return {
    index: SALES_VECTORIZE_INDEX,
    namespace: SALES_VECTORIZE_NAMESPACE,
    embedding_model: SALES_EMBEDDING_MODEL,
    embedding_pooling: SALES_EMBEDDING_POOLING,
    source_documents: retrievalIndex.documents.length,
    vector_records: vectorRecords.length,
  };
}

export function getSalesVectorizeSeedBatch(cursor = 0, batchSize = DEFAULT_SEED_BATCH_SIZE) {
  const start = Math.max(0, Math.floor(Number(cursor) || 0));
  const size = Math.max(1, Math.min(MAX_SEED_BATCH_SIZE, Math.floor(Number(batchSize) || DEFAULT_SEED_BATCH_SIZE)));
  return {
    cursor: start,
    records: vectorRecords.slice(start, start + size),
    next_cursor: Math.min(vectorRecords.length, start + size),
    total: vectorRecords.length,
  };
}

export async function seedSalesVectorizeBatch({ ai, index, cursor = 0, batchSize = DEFAULT_SEED_BATCH_SIZE }) {
  const batch = getSalesVectorizeSeedBatch(cursor, batchSize);
  if (batch.records.length === 0) {
    return { ...batch, processed: 0, complete: true, mutation_id: null };
  }

  const embeddingResponse = await ai.run(SALES_EMBEDDING_MODEL, {
    text: batch.records.map((record) => record.text),
    pooling: SALES_EMBEDDING_POOLING,
  });
  const values = embeddingVectors(embeddingResponse, batch.records.length);
  const mutation = await index.upsert(batch.records.map((record, recordIndex) => ({
    id: record.id,
    values: values[recordIndex],
    namespace: SALES_VECTORIZE_NAMESPACE,
    metadata: record.metadata,
  })));

  return {
    cursor: batch.cursor,
    next_cursor: batch.next_cursor,
    total: batch.total,
    processed: batch.records.length,
    complete: batch.next_cursor >= batch.total,
    mutation_id: mutation?.mutationId ?? null,
  };
}

export async function querySalesVectorize({ question, ai, index, topK = SALES_VECTORIZE_TOP_K }) {
  const query = String(question ?? "").trim();
  if (!query) return { status: "skipped", matches: [], reason: "empty_query" };

  const embeddingResponse = await ai.run(SALES_EMBEDDING_MODEL, {
    text: [query.slice(0, MAX_EMBEDDING_CHARACTERS)],
    pooling: SALES_EMBEDDING_POOLING,
  });
  const [queryVector] = embeddingVectors(embeddingResponse, 1);
  const result = await index.query(queryVector, {
    topK: Math.max(1, Math.min(20, Number(topK) || SALES_VECTORIZE_TOP_K)),
    namespace: SALES_VECTORIZE_NAMESPACE,
    returnMetadata: "all",
    returnValues: false,
  });

  return {
    status: "ready",
    index: SALES_VECTORIZE_INDEX,
    namespace: SALES_VECTORIZE_NAMESPACE,
    matches: (result?.matches ?? []).map((match) => ({
      id: String(match.id),
      score: Number(match.score) || 0,
      document_id: typeof match.metadata?.document_id === "string" ? match.metadata.document_id : "",
    })),
  };
}
