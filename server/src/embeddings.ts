import { getDb, nowIso, transaction } from "./db.js";
import { ollamaBaseUrl } from "./ollama.js";
import type { SqlRow } from "./types.js";

interface OllamaEmbedResponse {
  model?: string;
  embeddings?: unknown;
  error?: string;
}

export function embeddingModelEnabled(): boolean {
  return process.env.EMBEDDING_ENABLED?.trim().toLowerCase() === "true";
}

export function embeddingModelName(): string {
  return (
    process.env.OLLAMA_EMBEDDING_MODEL?.trim() || "qwen3-embedding:0.6b"
  );
}

function embeddingTimeoutMs(): number {
  return Number(process.env.OLLAMA_EMBEDDING_TIMEOUT_MS ?? 90_000);
}

function embeddingBatchSize(): number {
  return Math.min(
    64,
    Math.max(1, Number(process.env.OLLAMA_EMBEDDING_BATCH_SIZE ?? 16)),
  );
}

export function embeddingMinimumScore(): number {
  return Math.min(
    1,
    Math.max(0, Number(process.env.EMBEDDING_MIN_SCORE ?? 0.35)),
  );
}

function isNumberVector(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((item) => typeof item === "number" && Number.isFinite(item))
  );
}

export async function embedTexts(inputs: string[]): Promise<number[][]> {
  if (!inputs.length) return [];
  const response = await fetch(`${ollamaBaseUrl()}/api/embed`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal: AbortSignal.timeout(embeddingTimeoutMs()),
    body: JSON.stringify({
      model: embeddingModelName(),
      input: inputs,
      truncate: true,
      keep_alive: process.env.OLLAMA_KEEP_ALIVE?.trim() || "10m",
    }),
  });
  const result = (await response.json()) as OllamaEmbedResponse;
  if (!response.ok) {
    throw new Error(
      result.error || `Ollama embedding returned HTTP ${response.status}`,
    );
  }
  if (
    !Array.isArray(result.embeddings) ||
    result.embeddings.length !== inputs.length ||
    !result.embeddings.every(isNumberVector)
  ) {
    throw new Error("Ollama embedding returned invalid vectors");
  }
  const dimensions = result.embeddings[0]?.length;
  if (
    !dimensions ||
    result.embeddings.some((vector) => vector.length !== dimensions)
  ) {
    throw new Error("Ollama embedding returned inconsistent dimensions");
  }
  return result.embeddings;
}

export function cosineSimilarity(left: number[], right: number[]): number {
  if (!left.length || left.length !== right.length) return -1;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index] ?? 0;
    const rightValue = right[index] ?? 0;
    dot += leftValue * rightValue;
    leftNorm += leftValue * leftValue;
    rightNorm += rightValue * rightValue;
  }
  const denominator = Math.sqrt(leftNorm) * Math.sqrt(rightNorm);
  return denominator ? dot / denominator : -1;
}

async function saveEmbeddings(
  rows: SqlRow[],
  vectors: number[][],
): Promise<void> {
  const model = embeddingModelName();
  const timestamp = nowIso();
  await transaction(async () => {
    const statement = getDb().prepare(
      `INSERT INTO chunk_embeddings(
        chunk_id,model,dimensions,embedding,updated_at
       ) VALUES (?,?,?,?,?)
       ON DUPLICATE KEY UPDATE
         model=VALUES(model),
         dimensions=VALUES(dimensions),
         embedding=VALUES(embedding),
         updated_at=VALUES(updated_at)`,
    );
    for (const [index, row] of rows.entries()) {
      const vector = vectors[index];
      if (!vector) continue;
      await statement.run(
        Number(row.id),
        model,
        vector.length,
        JSON.stringify(vector),
        timestamp,
      );
    }
  });
}

async function indexRows(rows: SqlRow[]): Promise<number> {
  let indexed = 0;
  const size = embeddingBatchSize();
  for (let offset = 0; offset < rows.length; offset += size) {
    const batch = rows.slice(offset, offset + size);
    const vectors = await embedTexts(
      batch.map((row) => String(row.content)),
    );
    await saveEmbeddings(batch, vectors);
    indexed += batch.length;
  }
  return indexed;
}

export async function indexDocumentEmbeddings(
  documentId: number,
): Promise<number> {
  if (!embeddingModelEnabled()) return 0;
  const rows = await getDb()
    .prepare(
      `SELECT id,content FROM document_chunks
       WHERE document_id=? ORDER BY chunk_index`,
    )
    .all(documentId);
  return indexRows(rows);
}

export async function backfillMissingEmbeddings(): Promise<number> {
  if (!embeddingModelEnabled()) return 0;
  const model = embeddingModelName();
  const size = embeddingBatchSize();
  let indexed = 0;
  while (true) {
    const rows = await getDb()
      .prepare(
        `SELECT c.id,c.content
         FROM document_chunks c
         LEFT JOIN chunk_embeddings e
           ON e.chunk_id=c.id AND e.model=?
         WHERE e.chunk_id IS NULL
         ORDER BY c.id
         LIMIT ${size}`,
      )
      .all(model);
    if (!rows.length) break;
    indexed += await indexRows(rows);
  }
  return indexed;
}

export async function embeddingStats(): Promise<{
  chunks: number;
  indexed: number;
}> {
  const row = await getDb()
    .prepare(
      `SELECT
        (SELECT COUNT(*) FROM document_chunks) AS chunks,
        (SELECT COUNT(*) FROM chunk_embeddings WHERE model=?) AS indexed`,
    )
    .get(embeddingModelName());
  return {
    chunks: Number(row?.chunks ?? 0),
    indexed: Number(row?.indexed ?? 0),
  };
}
