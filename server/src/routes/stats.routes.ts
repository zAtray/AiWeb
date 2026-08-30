import { Router } from "express";
import { requireUser } from "../auth.js";
import { getDb } from "../db.js";
import { accessibleDocumentWhere, userOf } from "../services.js";
import type { AuthRequest, SqlRow } from "../types.js";

export function createStatsRouter(): Router {
  const router = Router();
  router.get("/", requireUser, async (request: AuthRequest, response) => {
    const user = userOf(request);
    const access = accessibleDocumentWhere(user);
    const totals = (await getDb()
      .prepare(
        `SELECT COUNT(*) AS documents,COALESCE(SUM(views),0) AS views,
           COALESCE(SUM(downloads),0) AS downloads
         FROM documents d WHERE ${access.sql}`,
      )
      .get(...access.params)) as SqlRow;
    const admin = ["department_admin", "system_admin"].includes(user.role);
    const knowledgeBases = (
      await getDb()
        .prepare(
          admin
            ? "SELECT COUNT(*) AS count FROM knowledge_bases"
            : `SELECT COUNT(*) AS count FROM knowledge_bases
               WHERE owner_id=? OR visibility IN ('shared','public')`,
        )
        .get(...(admin ? [] : [user.id]))
    )!.count;
    const searches = (
      await getDb()
        .prepare("SELECT COUNT(*) AS count FROM search_logs WHERE user_id=?")
        .get(user.id)
    )!.count;
    const categories = await getDb()
      .prepare(
        `SELECT category AS name,COUNT(*) AS value FROM documents d
         WHERE ${access.sql} GROUP BY category ORDER BY value DESC`,
      )
      .all(...access.params);
    const hotKeywords = await getDb()
      .prepare(
        `SELECT query AS name,COUNT(*) AS value FROM search_logs
         WHERE user_id=? GROUP BY query ORDER BY value DESC LIMIT 8`,
      )
      .all(user.id);
    const searchTrend = (
      await getDb()
        .prepare(
          `SELECT substr(created_at,1,10) AS date,COUNT(*) AS value
           FROM search_logs WHERE user_id=?
           GROUP BY substr(created_at,1,10) ORDER BY date DESC LIMIT 14`,
        )
        .all(user.id)
    ).reverse();
    const popularDocuments = await getDb()
      .prepare(
        `SELECT d.id,d.title,d.category,d.created_at,d.views,d.downloads,
          (d.views+d.downloads*2+(SELECT COUNT(*)*3 FROM likes l WHERE l.document_id=d.id)) AS popularity
         FROM documents d WHERE ${access.sql}
         ORDER BY popularity DESC,d.updated_at DESC LIMIT 8`,
      )
      .all(...access.params);
    const latestDocuments = await getDb()
      .prepare(
        `SELECT d.id,d.title,d.category,d.created_at,d.views,d.downloads
         FROM documents d WHERE ${access.sql}
         ORDER BY d.created_at DESC,d.id DESC LIMIT 8`,
      )
      .all(...access.params);
    response.json({
      documents: Number(totals.documents),
      knowledge_bases: Number(knowledgeBases),
      views: Number(totals.views),
      downloads: Number(totals.downloads),
      searches: Number(searches),
      categories,
      hot_keywords: hotKeywords,
      search_trend: searchTrend,
      popularDocuments,
      latestDocuments,
    });
  });
  return router;
}
