import fs from "node:fs";
import path from "node:path";
import cors from "cors";
import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";
import multer from "multer";
import { frontendDist, maxUploadMb } from "./config.js";
import { ApiError } from "./core.js";
import { initDb } from "./db.js";
import { createAdminRouter } from "./routes/admin.routes.js";
import { createAuthRouter } from "./routes/auth.routes.js";
import { createChatRouter } from "./routes/chat.routes.js";
import { createDocumentsRouter } from "./routes/documents.routes.js";
import { createInteractionsRouter } from "./routes/interactions.routes.js";
import { createKnowledgeRouter } from "./routes/knowledge.routes.js";
import { createSearchRouter } from "./routes/search.routes.js";
import { createStatsRouter } from "./routes/stats.routes.js";
import { createSystemRouter } from "./routes/system.routes.js";
import { seedAdmin } from "./services.js";

function apiErrorHandler(
  error: unknown,
  _request: Request,
  response: Response,
  _next: NextFunction,
): void {
  if (error instanceof multer.MulterError) {
    response
      .status(413)
      .json({ message: `文件超过 ${maxUploadMb} MB 上传大小限制` });
    return;
  }
  if (error instanceof ApiError) {
    response.status(error.status).json({ message: error.message });
    return;
  }
  if (
    (error as { code?: string }).code === "ER_DUP_ENTRY" ||
    (error instanceof Error && error.message.includes("UNIQUE constraint"))
  ) {
    response.status(409).json({ message: "数据已存在" });
    return;
  }
  console.error(error);
  response.status(500).json({
    message: error instanceof Error ? error.message : "服务器内部错误",
  });
}

export async function createApp() {
  await initDb();
  await seedAdmin();
  const app = express();
  app.use(cors({ origin: true, credentials: true }));
  app.use(express.json({ limit: "1mb" }));

  app.use("/api", createSystemRouter());
  app.use("/api/auth", createAuthRouter());
  app.use("/api/knowledge-bases", createKnowledgeRouter());
  app.use("/api", createInteractionsRouter());
  app.use("/api/documents", createDocumentsRouter());
  app.use("/api/search", createSearchRouter());
  app.use("/api/chat", createChatRouter());
  app.use("/api/admin", createAdminRouter());
  app.use("/api/stats", createStatsRouter());

  if (fs.existsSync(frontendDist)) {
    app.use(express.static(frontendDist));
    app.get(/.*/, (_request, response) => {
      response.sendFile(path.join(frontendDist, "index.html"));
    });
  }

  app.use(apiErrorHandler);
  return app;
}
