import { Router } from "express";
import { requireUser } from "../auth.js";
import { numberId, strictLimit, text } from "../core.js";
import { getDb, nowIso } from "../db.js";
import { searchChunks, userOf } from "../services.js";
import type { AuthRequest } from "../types.js";

export function createSearchRouter(): Router {
  const router = Router();
  router.get("/", requireUser, async (request: AuthRequest, response) => {
    const query = text(request.query.q, "检索词", 500);
    const knowledgeBaseId = request.query.knowledge_base_id
      ? numberId(request.query.knowledge_base_id)
      : undefined;
    const limit = strictLimit(request.query.limit, 12, 50);
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
    const relatedByDocument = new Map<
      number,
      {
        id: number;
        title: string;
        category: string;
        tags: string[];
        score: number;
        matched_fragments: number;
      }
    >();
    for (const hit of searchResult.hits) {
      const existing = relatedByDocument.get(hit.document_id);
      if (existing) {
        existing.score = Math.max(existing.score, hit.score);
        existing.matched_fragments += 1;
      } else {
        relatedByDocument.set(hit.document_id, {
          id: hit.document_id,
          title: hit.title,
          category: hit.category,
          tags: hit.tags,
          score: hit.score,
          matched_fragments: 1,
        });
      }
    }
    response.json({
      query,
      mode: "fulltext",
      retrieval_engine: searchResult.engine,
      results: searchResult.hits,
      related_documents: [...relatedByDocument.values()]
        .sort(
          (left, right) =>
            right.score - left.score ||
            right.matched_fragments - left.matched_fragments,
        )
        .slice(0, 6),
    });
  });
  return router;
}
