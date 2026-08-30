import {
  backfillMissingEmbeddings,
  EmbeddingProviderError,
  embeddingModelEnabled,
  indexDocumentEmbeddings,
} from "./embeddings.js";

type EmbeddingJob =
  | { kind: "document"; documentId: number }
  | { kind: "backfill" };

const jobs: EmbeddingJob[] = [];
const queuedDocuments = new Set<number>();
const rerunDocuments = new Set<number>();
let backfillQueued = false;
let workerRunning = false;

function jobLabel(job: EmbeddingJob): string {
  return job.kind === "document" ? `文档 ${job.documentId}` : "缺失向量回填";
}

async function execute(job: EmbeddingJob): Promise<number> {
  return job.kind === "document"
    ? indexDocumentEmbeddings(job.documentId)
    : backfillMissingEmbeddings();
}

async function runJob(job: EmbeddingJob): Promise<void> {
  const retryDelays = [5_000, 15_000, 30_000];
  for (let attempt = 0; attempt <= retryDelays.length; attempt += 1) {
    try {
      const count = await execute(job);
      console.log(`${jobLabel(job)}向量索引已同步：${count} 个片段`);
      return;
    } catch (error) {
      const retryable = error instanceof EmbeddingProviderError && error.retryable;
      if (!retryable || attempt === retryDelays.length) throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, retryDelays[attempt]));
    }
  }
}

function startWorker(): void {
  if (workerRunning) return;
  workerRunning = true;
  setImmediate(() => {
    void (async () => {
      while (jobs.length) {
        const job = jobs.shift()!;
        try {
          await runJob(job);
        } catch (error) {
          console.warn(
            `${jobLabel(job)}向量索引失败；全文检索仍可用：`,
            error instanceof Error ? error.message : error,
          );
        } finally {
          if (job.kind === "document") {
            if (rerunDocuments.delete(job.documentId)) {
              jobs.push({ kind: "document", documentId: job.documentId });
            } else {
              queuedDocuments.delete(job.documentId);
            }
          } else backfillQueued = false;
        }
      }
      workerRunning = false;
      if (jobs.length) startWorker();
    })();
  });
}

export function queueDocumentEmbedding(documentId: number): boolean {
  if (!embeddingModelEnabled()) return false;
  if (queuedDocuments.has(documentId)) {
    // A version update can arrive while the original upload job is queued or
    // running. Remember one trailing pass so the newest current-version chunks
    // are never lost behind document-level deduplication.
    rerunDocuments.add(documentId);
    return true;
  }
  queuedDocuments.add(documentId);
  jobs.push({ kind: "document", documentId });
  startWorker();
  return true;
}

export function queueMissingEmbeddings(): boolean {
  if (!embeddingModelEnabled()) return false;
  if (backfillQueued) return true;
  backfillQueued = true;
  jobs.push({ kind: "backfill" });
  startWorker();
  return true;
}
