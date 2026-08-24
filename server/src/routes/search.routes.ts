import { Router } from "express";
import { requireUser } from "../auth.js";
import { text } from "../core.js";
import { getDb, nowIso } from "../db.js";
import { searchChunks, userOf } from "../services.js";
import type { AuthRequest } from "../types.js";

export function createSearchRouter(): Router {
  const router = Router();
  router.get("/", requireUser, async (request: AuthRequest, response) => {
    const query = text(request.query.q, "检索词", 500);
    const knowledgeBaseId = request.query.knowledge_base_id
      ? Number(request.query.knowledge_base_id)
      : undefined;
    const limit = Math.min(50, Math.max(1, Number(request.query.limit ?? 12)));
    const searchResult = await searchChunks(userOf(request), query, {
      knowledgeBaseId,
      category:
        typeof request.query.category === "string"
          ? request.query.category
          : undefined,
      tag: typeof request.query.tag === "string" ? request.query.tag : undefined,
      limit,
    });
    await getDb()
      .prepare(
        `INSERT INTO search_logs(user_id,query,mode,created_at)
         VALUES (?,?,'fulltext',?)`,
      )
      .run(userOf(request).id, query, nowIso());
    response.json({
      query,
      mode: "fulltext",
      retrieval_engine: searchResult.engine,
      results: searchResult.hits,
    });
  });
  return router;
}
