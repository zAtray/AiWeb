import { Router } from "express";
import { requireUser } from "../auth.js";
import { ApiError, numberId, optionalText, text } from "../core.js";
import { getDb, nowIso } from "../db.js";
import {
  canAccessDocument,
  canAccessKnowledgeBase,
  userOf,
} from "../services.js";
import type { AuthRequest } from "../types.js";

export function createKnowledgeRouter(): Router {
  const router = Router();
  router.use(requireUser);

  router.get("/", async (request: AuthRequest, response) => {
    const user = userOf(request);
    const admin = ["department_admin", "system_admin"].includes(user.role);
    const rows = await getDb()
      .prepare(
        `SELECT k.*,u.username AS owner_name,
           COUNT(kd.document_id) AS document_count
         FROM knowledge_bases k JOIN users u ON u.id=k.owner_id
         LEFT JOIN kb_documents kd ON kd.knowledge_base_id=k.id
         ${admin ? "" : "WHERE k.owner_id=? OR k.visibility IN ('shared','public')"}
         GROUP BY k.id ORDER BY k.updated_at DESC`,
      )
      .all(...(admin ? [] : [user.id]));
    response.json(rows);
  });

  router.post("/", async (request: AuthRequest, response) => {
    const user = userOf(request);
    const name = text(request.body?.name, "知识库名称", 80);
    const description = optionalText(request.body?.description, 500);
    const visibility = String(request.body?.visibility ?? "private");
    if (!["private", "shared", "public"].includes(visibility)) {
      throw new ApiError(400, "访问权限无效");
    }
    const timestamp = nowIso();
    try {
      const result = await getDb()
        .prepare(
          `INSERT INTO knowledge_bases(
            owner_id,name,description,visibility,created_at,updated_at
           ) VALUES (?,?,?,?,?,?)`,
        )
        .run(user.id, name, description, visibility, timestamp, timestamp);
      response.status(201).json(
        await getDb()
          .prepare("SELECT * FROM knowledge_bases WHERE id=?")
          .get(result.lastInsertRowid),
      );
    } catch (error) {
      if (
        (error as { code?: string }).code === "ER_DUP_ENTRY" ||
        String(error).includes("UNIQUE")
      ) {
        throw new ApiError(409, "你已有同名知识库");
      }
      throw error;
    }
  });

  router.put("/:id", async (request: AuthRequest, response) => {
    const id = numberId(request.params.id);
    await canAccessKnowledgeBase(id, userOf(request), true);
    const name = text(request.body?.name, "知识库名称", 80);
    const description = optionalText(request.body?.description, 500);
    const visibility = String(request.body?.visibility ?? "private");
    if (!["private", "shared", "public"].includes(visibility)) {
      throw new ApiError(400, "访问权限无效");
    }
    await getDb()
      .prepare(
        `UPDATE knowledge_bases
         SET name=?,description=?,visibility=?,updated_at=? WHERE id=?`,
      )
      .run(name, description, visibility, nowIso(), id);
    response.json(
      await getDb().prepare("SELECT * FROM knowledge_bases WHERE id=?").get(id),
    );
  });

  router.delete("/:id", async (request: AuthRequest, response) => {
    const id = numberId(request.params.id);
    await canAccessKnowledgeBase(id, userOf(request), true);
    await getDb().prepare("DELETE FROM knowledge_bases WHERE id=?").run(id);
    response.status(204).end();
  });

  router.post("/:id/documents", async (request: AuthRequest, response) => {
    const id = numberId(request.params.id);
    const documentId = numberId(request.body?.document_id);
    const user = userOf(request);
    await canAccessKnowledgeBase(id, user, true);
    await canAccessDocument(documentId, user, true);
    await getDb()
      .prepare(
        `INSERT IGNORE INTO kb_documents(
          knowledge_base_id,document_id,added_at
         ) VALUES (?,?,?)`,
      )
      .run(id, documentId, nowIso());
    await getDb()
      .prepare("UPDATE knowledge_bases SET updated_at=? WHERE id=?")
      .run(nowIso(), id);
    response.status(201).json({ ok: true });
  });

  router.delete(
    "/:id/documents/:documentId",
    async (request: AuthRequest, response) => {
      const id = numberId(request.params.id);
      const documentId = numberId(request.params.documentId);
      await canAccessKnowledgeBase(id, userOf(request), true);
      await getDb()
        .prepare(
          `DELETE FROM kb_documents
           WHERE knowledge_base_id=? AND document_id=?`,
        )
        .run(id, documentId);
      response.status(204).end();
    },
  );

  return router;
}
