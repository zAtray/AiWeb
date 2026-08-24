import { Router } from "express";
import { requireUser } from "../auth.js";
import {
  allowedExtensions,
  maxUploadMb,
  pdfOcrEnabled,
  pdfOcrMaxPages,
} from "../config.js";
import { databaseInfo } from "../db.js";
import {
  embeddingModelEnabled,
  embeddingModelName,
  embeddingStats,
} from "../embeddings.js";
import {
  localModelEnabled,
  localModelName,
  ollamaBaseUrl,
  ollamaConnectionStatus,
} from "../ollama.js";

export function createSystemRouter(): Router {
  const router = Router();

  router.get("/config", (_request, response) => {
    response.json({
      upload: {
        max_mb: maxUploadMb,
        allowed_extensions: [...allowedExtensions],
        pdf_ocr_enabled: pdfOcrEnabled,
        pdf_ocr_max_pages: pdfOcrMaxPages,
      },
    });
  });

  router.get("/health", async (_request, response) => {
    const mysql = await databaseInfo();
    const modelEnabled = localModelEnabled();
    const embeddingsEnabled = embeddingModelEnabled();
    const embeddingIndex = embeddingsEnabled ? await embeddingStats() : null;
    const modelServer = ollamaBaseUrl();
    const remoteModelConfigured =
      (modelEnabled || embeddingsEnabled) &&
      !/^https?:\/\/(?:127\.0\.0\.1|localhost)(?::|\/|$)/u.test(modelServer);
    response.json({
      status: "ok",
      app: "智知",
      database: "mysql",
      database_name: mysql.database,
      database_version: mysql.version,
      answer_engine: modelEnabled ? "local-qwen3-rag" : "local-extractive",
      local_model_configured: modelEnabled,
      local_model: modelEnabled ? localModelName() : null,
      retrieval_engine: embeddingsEnabled ? "hybrid-vector-lexical" : "lexical",
      embedding_model_configured: embeddingsEnabled,
      embedding_model: embeddingsEnabled ? embeddingModelName() : null,
      embedding_index: embeddingIndex,
      remote_model_configured: remoteModelConfigured,
    });
  });

  router.get("/model/status", requireUser, async (_request, response) => {
    const embeddingsEnabled = embeddingModelEnabled();
    const connection = await ollamaConnectionStatus(
      localModelEnabled() || embeddingsEnabled,
    );
    const embeddingIndex = embeddingsEnabled ? await embeddingStats() : null;
    const availableModels = new Set(connection.available_models);
    const answerModel = localModelEnabled() ? localModelName() : null;
    const embeddingModel = embeddingsEnabled ? embeddingModelName() : null;
    const answerAvailable = answerModel ? availableModels.has(answerModel) : false;
    const embeddingAvailable = embeddingModel
      ? availableModels.has(embeddingModel)
      : false;
    const status = !localModelEnabled() && !embeddingsEnabled
      ? "disabled"
      : !connection.connected
        ? "offline"
        : (!answerModel || answerAvailable) &&
            (!embeddingModel || embeddingAvailable)
          ? "connected"
          : "model_missing";
    response.json({
      ...connection,
      status,
      configured: localModelEnabled() || embeddingsEnabled,
      model: answerModel,
      model_available: answerAvailable,
      answer_model: {
        configured: localModelEnabled(),
        name: answerModel,
        available: answerAvailable,
      },
      embedding_model: {
        configured: embeddingsEnabled,
        name: embeddingModel,
        available: embeddingAvailable,
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
