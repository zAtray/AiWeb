import { getDb, nowIso, transaction } from "./db.js";
import type { SqlRow } from "./types.js";

export interface EmbeddingProvider {
  embed(text: string): Promise<number[]>;
  embedBatch?(texts: string[]): Promise<number[][]>;
}

interface EmbeddingApiResponse {
  data?: Array<{ embedding?: unknown; index?: unknown }>;
  model?: unknown;
  error?: { message?: unknown };
}

export class EmbeddingProviderError extends Error {
  constructor(
    message: string,
    readonly code:
      | "configuration"
      | "authentication"
      | "rate_limit"
      | "upstream"
      | "timeout"
      | "network"
      | "invalid_response",
    readonly retryable = false,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "EmbeddingProviderError";
  }
}

function boundedInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const parsed = Number(value ?? fallback);
  return Number.isFinite(parsed)
    ? Math.min(maximum, Math.max(minimum, Math.floor(parsed)))
    : fallback;
}

export function embeddingProviderName(): string {
  const name = process.env.EMBEDDING_PROVIDER?.trim().toLowerCase();
  return name || "api";
}

export function embeddingApiBaseUrl(): string {
  return (process.env.EMBEDDING_API_BASE_URL?.trim() || "").replace(/\/+$/u, "");
}

export function embeddingModelName(): string {
  return process.env.EMBEDDING_API_MODEL?.trim() || "";
}

export function embeddingGeneration(): string {
  return process.env.EMBEDDING_GENERATION?.trim() || "1";
}

export function embeddingApiConfigured(): boolean {
  return embeddingProviderName() === "api" && Boolean(
    embeddingApiBaseUrl() && embeddingModelName() && process.env.EMBEDDING_API_KEY?.trim() &&
    Number(process.env.EMBEDDING_API_DIMENSION) > 0,
  );
}

export function embeddingModelEnabled(): boolean {
  const name = embeddingProviderName();
  if (name === "disabled") return false;
  if (name === "api") return embeddingApiConfigured();
  return false;
}

function embeddingBatchSize(): number {
  return Math.min(
    64,
    Math.max(1, Number(process.env.EMBEDDING_API_BATCH_SIZE ?? 16)),
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

function errorForStatus(
  status: number,
  message: string,
  retryAfterMs?: number,
): EmbeddingProviderError {
  if (status === 401 || status === 403) {
    return new EmbeddingProviderError(message, "authentication");
  }
  if (status === 429) return new EmbeddingProviderError(message, "rate_limit", true, retryAfterMs);
  if (status >= 500) return new EmbeddingProviderError(message, "upstream", true, retryAfterMs);
  return new EmbeddingProviderError(message, "upstream");
}

function retryAfterMilliseconds(response: Response): number | undefined {
  const value = response.headers.get("retry-after")?.trim();
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

function defaultRetryDelay(attempt: number): number {
  return [1_000, 3_000, 10_000, 20_000, 30_000][attempt] ?? 30_000;
}

export class ApiEmbeddingProvider implements EmbeddingProvider {
  constructor(
    private readonly options: {
      baseUrl?: string;
      apiKey?: string;
      model?: string;
      timeoutMs?: number;
      maxRetries?: number;
      expectedDimensions?: number;
      fetcher?: typeof fetch;
      sleeper?: (milliseconds: number) => Promise<void>;
    } = {},
  ) {}

  async embed(text: string): Promise<number[]> {
    const [vector] = await this.embedBatch([text]);
    if (!vector) throw new EmbeddingProviderError("Embedding API 返回空向量", "invalid_response");
    return vector;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (!texts.length) return [];
    const baseUrl = (this.options.baseUrl ?? embeddingApiBaseUrl()).replace(/\/+$/u, "");
    const apiKey = this.options.apiKey ?? process.env.EMBEDDING_API_KEY?.trim() ?? "";
    const model = this.options.model ?? embeddingModelName();
    if (!baseUrl || !apiKey || !model) {
      throw new EmbeddingProviderError("Embedding API 配置不完整", "configuration");
    }
    const timeoutMs = this.options.timeoutMs ?? boundedInteger(
      process.env.EMBEDDING_API_TIMEOUT_MS,
      30_000,
      1_000,
      180_000,
    );
    const maxRetries = this.options.maxRetries ?? boundedInteger(
      process.env.EMBEDDING_API_MAX_RETRIES,
      3,
      0,
      5,
    );
    const configuredDimensions = this.options.expectedDimensions ?? Number(
      process.env.EMBEDDING_API_DIMENSION ?? 0,
    );
    const fetcher = this.options.fetcher ?? fetch;
    let lastError: EmbeddingProviderError | undefined;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      const startedAt = Date.now();
      try {
        const response = await fetcher(`${baseUrl}/embeddings`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${apiKey}`,
            "content-type": "application/json",
          },
          signal: AbortSignal.timeout(timeoutMs),
          body: JSON.stringify({ model, input: texts }),
        });
        const raw = await response.text();
        let payload: EmbeddingApiResponse;
        try {
          payload = JSON.parse(raw) as EmbeddingApiResponse;
        } catch {
          throw new EmbeddingProviderError("Embedding API 返回了非 JSON 响应", "invalid_response");
        }
        if (!response.ok) {
          const message = typeof payload.error?.message === "string"
            ? payload.error.message.slice(0, 300)
            : `HTTP ${response.status}`;
          throw errorForStatus(
            response.status,
            `Embedding API 请求失败：${message}`,
            retryAfterMilliseconds(response),
          );
        }
        if (!Array.isArray(payload.data) || payload.data.length !== texts.length) {
          throw new EmbeddingProviderError("Embedding API 返回数量与输入不一致", "invalid_response");
        }
        const ordered = [...payload.data].sort((left, right) =>
          Number(left.index ?? 0) - Number(right.index ?? 0));
        const vectors = ordered.map((item) => item.embedding);
        if (!vectors.every(isNumberVector)) {
          throw new EmbeddingProviderError("Embedding API 返回空向量或非法数值", "invalid_response");
        }
        const dimensions = vectors[0]!.length;
        if (
          vectors.some((vector) => vector.length !== dimensions) ||
          (configuredDimensions > 0 && dimensions !== configuredDimensions)
        ) {
          throw new EmbeddingProviderError("Embedding API 返回向量维度不一致", "invalid_response");
        }
        console.info("Embedding provider call", {
          provider: "api", model, latency_ms: Date.now() - startedAt,
          success: true, attempt, dimensions, count: vectors.length,
        });
        return vectors;
      } catch (error) {
        const providerError = error instanceof EmbeddingProviderError
          ? error
          : error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError")
            ? new EmbeddingProviderError("Embedding API 请求超时", "timeout", true)
            : new EmbeddingProviderError(
                `Embedding API 网络请求失败：${error instanceof Error ? error.message : "未知错误"}`,
                "network",
                true,
              );
        lastError = providerError;
        console.info("Embedding provider call", {
          provider: "api", model, latency_ms: Date.now() - startedAt,
          success: false, reason: providerError.code, attempt,
        });
        if (!providerError.retryable || attempt === maxRetries) throw providerError;
        const delay = Math.min(
          60_000,
          Math.max(providerError.retryAfterMs ?? 0, defaultRetryDelay(attempt)),
        );
        await (this.options.sleeper ?? ((milliseconds) =>
          new Promise<void>((resolve) => setTimeout(resolve, milliseconds))))(delay);
      }
    }
    throw lastError ?? new EmbeddingProviderError("Embedding API 调用失败", "network");
  }
}

let providerOverride: EmbeddingProvider | undefined;

export function setEmbeddingProviderForTests(provider?: EmbeddingProvider): void {
  providerOverride = provider;
}

export function getEmbeddingProvider(): EmbeddingProvider {
  if (providerOverride) return providerOverride;
  const name = embeddingProviderName();
  if (name === "api") return new ApiEmbeddingProvider();
  throw new EmbeddingProviderError(
    `不支持的 EMBEDDING_PROVIDER：${name}`,
    "configuration",
  );
}

export async function embedTexts(inputs: string[]): Promise<number[][]> {
  if (!inputs.length) return [];
  const provider = getEmbeddingProvider();
  if (provider.embedBatch) return provider.embedBatch(inputs);
  return Promise.all(inputs.map((input) => provider.embed(input)));
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
): Promise<number> {
  return transaction(() => writeEmbeddings(rows, vectors));
}

async function writeEmbeddings(rows: SqlRow[], vectors: number[][]): Promise<number> {
    const provider = embeddingProviderName();
    const model = embeddingModelName();
    const generation = embeddingGeneration();
    const timestamp = nowIso();
    let saved = 0;
    const statement = getDb().prepare(
      `INSERT INTO chunk_embeddings(
        chunk_id,provider,model,dimensions,generation,document_version,stale,embedding,updated_at
       ) SELECT c.id,?,?,?,?,?,0,?,?
         FROM document_chunks c
         JOIN documents d ON d.id=c.document_id
        WHERE c.id=? AND c.document_id=? AND d.version=?
       ON DUPLICATE KEY UPDATE
         provider=VALUES(provider),
         model=VALUES(model),
         dimensions=VALUES(dimensions),
         generation=VALUES(generation),
         document_version=VALUES(document_version),
         stale=0,
         embedding=VALUES(embedding),
         updated_at=VALUES(updated_at)`,
    );
    for (const [index, row] of rows.entries()) {
      const vector = vectors[index];
      if (!vector) continue;
      const result = await statement.run(
        provider,
        model,
        vector.length,
        generation,
        Number(row.document_version),
        JSON.stringify(vector),
        timestamp,
        Number(row.id),
        Number(row.document_id),
        Number(row.document_version),
      );
      if (result.changes > 0) saved += 1;
    }
    return saved;
}

async function indexRows(rows: SqlRow[]): Promise<number> {
  let indexed = 0;
  const size = embeddingBatchSize();
  for (let offset = 0; offset < rows.length; offset += size) {
    const batch = rows.slice(offset, offset + size);
    const vectors = await embedTexts(
      batch.map((row) => String(row.content)),
    );
    indexed += await saveEmbeddings(batch, vectors);
  }
  return indexed;
}

export async function indexDocumentEmbeddings(
  documentId: number,
): Promise<number> {
  if (!embeddingModelEnabled()) return 0;
  const provider = embeddingProviderName();
  const model = embeddingModelName();
  const generation = embeddingGeneration();
  const rows = await getDb()
    .prepare(
      `SELECT c.id,c.content,c.document_id,d.version AS document_version
       FROM document_chunks c
       JOIN documents d ON d.id=c.document_id
       LEFT JOIN chunk_embeddings e ON e.chunk_id=c.id
         AND e.provider=? AND e.model=? AND e.generation=?
       WHERE c.document_id=? AND d.status='ready' AND c.document_version=d.version
         AND (e.chunk_id IS NULL OR e.stale=1 OR e.document_version<>d.version)
       ORDER BY c.chunk_index`,
    )
    .all(provider, model, generation, documentId);
  return indexRows(rows);
}

export async function backfillMissingEmbeddings(): Promise<number> {
  if (!embeddingModelEnabled()) return 0;
  const model = embeddingModelName();
  const provider = embeddingProviderName();
  const generation = embeddingGeneration();
  const size = embeddingBatchSize();
  let indexed = 0;
  while (true) {
    const rows = await getDb()
      .prepare(
        `SELECT c.id,c.content,c.document_id,d.version AS document_version
         FROM document_chunks c
         JOIN documents d ON d.id=c.document_id
         LEFT JOIN chunk_embeddings e ON e.chunk_id=c.id
           AND e.provider=? AND e.model=? AND e.generation=?
         WHERE d.status='ready' AND c.document_version=d.version
           AND (e.chunk_id IS NULL OR e.stale=1 OR e.document_version<>d.version)
         ORDER BY c.id
         LIMIT ${size}`,
      )
      .all(provider, model, generation);
    if (!rows.length) break;
    indexed += await indexRows(rows);
  }
  return indexed;
}

async function sourceSnapshot(forUpdate = false): Promise<string> {
  const documents = await getDb().prepare(
    `SELECT id,version,status FROM documents ORDER BY id${forUpdate ? " FOR UPDATE" : ""}`,
  ).all();
  const chunks = await getDb().prepare(
    `SELECT id,document_id,document_version,CHAR_LENGTH(content) AS content_length
       FROM document_chunks ORDER BY id${forUpdate ? " FOR UPDATE" : ""}`,
  ).all();
  return JSON.stringify({ documents, chunks });
}

export async function embeddingSourceStats(): Promise<{ documents: number; chunks: number }> {
  const snapshot = JSON.parse(await sourceSnapshot()) as { documents: unknown[]; chunks: unknown[] };
  return { documents: snapshot.documents.length, chunks: snapshot.chunks.length };
}

export async function rebuildAllEmbeddings(): Promise<{
  documents: number;
  chunks: number;
  indexed: number;
}> {
  if (!embeddingModelEnabled()) throw new EmbeddingProviderError("Embedding API 配置不完整", "configuration");
  const before = await sourceSnapshot();
  const rows = await getDb().prepare(
    `SELECT c.id,c.content,c.document_id,d.version AS document_version
       FROM document_chunks c JOIN documents d ON d.id=c.document_id
      WHERE d.status='ready' AND c.document_version=d.version ORDER BY c.id`,
  ).all();
  const vectors: number[][] = [];
  const size = embeddingBatchSize();
  for (let offset = 0; offset < rows.length; offset += size) {
    vectors.push(...await embedTexts(rows.slice(offset, offset + size).map((row) => String(row.content))));
  }
  const indexed = await transaction(async () => {
    const locked = await sourceSnapshot(true);
    if (locked !== before) {
      throw new EmbeddingProviderError("文档或 chunk 在生成向量期间发生变化，已在清空旧向量前中止", "invalid_response");
    }
    await getDb().prepare("DELETE FROM chunk_embeddings").run();
    return writeEmbeddings(rows, vectors);
  });
  const after = await sourceSnapshot();
  if (after !== before) {
    throw new EmbeddingProviderError("重建前后文档/chunk 快照不一致，请立即停止验收并检查并发写入", "invalid_response");
  }
  const parsed = JSON.parse(before) as { documents: unknown[]; chunks: unknown[] };
  return { documents: parsed.documents.length, chunks: parsed.chunks.length, indexed };
}

export async function embeddingStats(): Promise<{
  chunks: number;
  indexed: number;
  stale: number;
}> {
  const provider = embeddingProviderName();
  const model = embeddingModelName();
  const generation = embeddingGeneration();
  const row = await getDb()
    .prepare(
      `SELECT
        (SELECT COUNT(*) FROM document_chunks c
          JOIN documents d ON d.id=c.document_id
          WHERE d.status='ready' AND c.document_version=d.version) AS chunks,
        (SELECT COUNT(*) FROM chunk_embeddings e
          JOIN document_chunks c ON c.id=e.chunk_id
          JOIN documents d ON d.id=c.document_id
          WHERE provider=? AND model=? AND generation=? AND stale=0
            AND d.status='ready' AND c.document_version=d.version
            AND e.document_version=d.version) AS indexed,
        (SELECT COUNT(*) FROM chunk_embeddings
          WHERE stale=1 OR provider<>? OR model<>? OR generation<>?) AS stale`,
    )
    .get(provider, model, generation, provider, model, generation);
  return {
    chunks: Number(row?.chunks ?? 0),
    indexed: Number(row?.indexed ?? 0),
    stale: Number(row?.stale ?? 0),
  };
}
