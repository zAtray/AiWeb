import { Router } from "express";
import { requireUser } from "../auth.js";
import {
  allowedExtensions,
  maxUploadMb,
  pdfOcrEnabled,
  pdfOcrMaxPages,
} from "../config.js";
import { databaseInfo, getDb } from "../db.js";
import { detectOcrCapability } from "../ocr.js";
import {
  embeddingApiConfigured,
  embeddingGeneration,
  embeddingModelEnabled,
  embeddingModelName,
  embeddingProviderName,
  embeddingStats,
  getEmbeddingProvider,
} from "../embeddings.js";
import {
  llmApiConfigured,
  llmApiModel,
  llmProviderConfigured,
  llmProviderName,
  getLLMProvider,
} from "../llm-provider.js";

type Availability = { available: boolean; latency_ms: number | null; checked_at: string };
const availabilityCache = new Map<string, { expires: number; value: Availability }>();

async function cachedAvailability(key: string, configured: boolean, probe: () => Promise<void>): Promise<Availability> {
  if (!configured) return { available: false, latency_ms: null, checked_at: new Date().toISOString() };
  const cached = availabilityCache.get(key);
  if (cached && cached.expires > Date.now()) return cached.value;
  const started = Date.now();
  let available = false;
  try { await probe(); available = true; } catch { available = false; }
  const value = { available, latency_ms: Date.now() - started, checked_at: new Date().toISOString() };
  availabilityCache.set(key, { expires: Date.now() + 60_000, value });
  return value;
}

export function createSystemRouter(): Router {
  const router = Router();

  router.get("/config", async (_request, response) => {
    const ocr = await detectOcrCapability();
    response.json({
      upload: {
        max_mb: maxUploadMb,
        allowed_extensions: [...allowedExtensions],
        pdf_ocr_enabled: pdfOcrEnabled,
        ocr_available: ocr.available,
        ocr_message: ocr.message,
        pdf_ocr_max_pages: pdfOcrMaxPages,
      },
    });
  });

  router.get("/health", async (_request, response) => {
    const mysql = await databaseInfo();
    const ocr = await detectOcrCapability();
    const answerConfigured = llmProviderConfigured();
    const cloudApiConfigured = llmApiConfigured();
    const embeddingsEnabled = embeddingModelEnabled();
    const embeddingIndex = embeddingsEnabled ? await embeddingStats() : null;
    const [llmAvailability, embeddingAvailability] = await Promise.all([
      cachedAvailability("llm", answerConfigured, async () => {
        // DeepSeek-compatible endpoints may spend a few output tokens before
        // emitting the visible answer. Keep the probe small, but not so small
        // that a healthy model is misreported as returning empty content.
        await getLLMProvider().chat({ messages: [{ role: "user", content: "仅回复 OK" }], maxTokens: 256 });
      }),
      cachedAvailability("embedding", embeddingsEnabled, async () => {
        await getEmbeddingProvider().embed("health check");
      }),
    ]);
    const lexical = await getDb().prepare(
      `SELECT (SELECT COUNT(*) FROM document_chunks) AS chunks,
              (SELECT COUNT(*) FROM rag_chunk_search) AS indexed`,
    ).get();
    response.json({
      status: "ok",
      app: "智知",
      database: "mysql",
      database_name: mysql.database,
      database_version: mysql.version,
      answer_engine: llmAvailability.available ? "cloud-llm-api" : "extractive-fallback",
      llm: {
        provider: llmProviderName(), model: llmApiModel() || null,
        configured: cloudApiConfigured, ...llmAvailability,
      },
      retrieval_engine: embeddingsEnabled ? "hybrid-vector-lexical" : "lexical",
      embedding: {
        provider: embeddingProviderName(), model: embeddingModelName() || null,
        dimension: Number(process.env.EMBEDDING_API_DIMENSION || 0) || null,
        generation: embeddingGeneration(), configured: embeddingsEnabled,
        ...embeddingAvailability, index: embeddingIndex,
      },
      lexical_index: {
        chunks: Number(lexical?.chunks ?? 0), indexed: Number(lexical?.indexed ?? 0),
        pending: Math.max(0, Number(lexical?.chunks ?? 0) - Number(lexical?.indexed ?? 0)),
      },
      ocr_available: ocr.available,
      ocr_status: ocr,
    });
  });

  router.get("/model/status", requireUser, async (_request, response) => {
    const embeddingsEnabled = embeddingModelEnabled();
    const answerEnabled = llmProviderConfigured();
    const embeddingIndex = embeddingsEnabled ? await embeddingStats() : null;
    const answerModel = answerEnabled ? llmApiModel() : null;
    const embeddingModel = embeddingsEnabled ? embeddingModelName() : null;
    const [llmAvailability, embeddingAvailability] = await Promise.all([
      cachedAvailability("llm", answerEnabled, async () => {
        // 推理模型（如 DeepSeek-V4-Flash）会先输出 reasoning_content 再输出
        // 正式答案；maxTokens 太小会被思考占满，导致 content 为空而被误报
        // 为模型缺失。与 /health 探针保持一致。
        await getLLMProvider().chat({ messages: [{ role: "user", content: "仅回复 OK" }], maxTokens: 256 });
      }),
      cachedAvailability("embedding", embeddingsEnabled, async () => {
        await getEmbeddingProvider().embed("health check");
      }),
    ]);
    const configured = answerEnabled || embeddingsEnabled;
    const status = !configured
      ? "disabled"
      : llmAvailability.available || embeddingAvailability.available ? "connected" : "offline";
    response.json({
      status,
      configured,
      connected: llmAvailability.available || embeddingAvailability.available,
      model: answerModel,
      model_available: llmAvailability.available,
      latency_ms: llmAvailability.latency_ms,
      provider: llmProviderName(),
      answer_model: {
        configured: answerEnabled,
        name: answerModel,
        available: llmAvailability.available,
      },
      embedding_model: {
        configured: embeddingsEnabled,
        name: embeddingModel,
        available: embeddingAvailability.available,
      },
      embedding_index: embeddingIndex
        ? {
            ...embeddingIndex,
            pending: Math.max(0, embeddingIndex.chunks - embeddingIndex.indexed),
          }
        : null,
    });
  });

  return router;
}
