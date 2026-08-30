import { Router, type Response } from "express";
import { requireUser } from "../auth.js";
import { ApiError, numberId, text } from "../core.js";
import { getDb, nowIso, transaction } from "../db.js";
import { canAccessDocument, userOf } from "../services.js";
import type { AuthRequest, SqlRow } from "../types.js";

async function toggleRelation(
  table: "favorites" | "likes",
  request: AuthRequest,
  response: Response,
): Promise<void> {
  const id = numberId(request.params.id);
  const user = userOf(request);
  await canAccessDocument(id, user);
  const active = await transaction(async () => {
    const existing = await getDb()
      .prepare(`SELECT 1 FROM ${table} WHERE user_id=? AND document_id=? FOR UPDATE`)
      .get(user.id, id);
    if (existing) {
      await getDb().prepare(`DELETE FROM ${table} WHERE user_id=? AND document_id=?`)
        .run(user.id, id);
      return false;
    }
    try {
      await getDb()
        .prepare(`INSERT INTO ${table}(user_id,document_id,created_at) VALUES (?,?,?)`)
        .run(user.id, id, nowIso());
      return true;
    } catch (error) {
      // 并发 toggle 可能在 SELECT 与 INSERT 之间由另一事务插入同一行，
      // 触发唯一约束冲突。此时该行已存在，按 toggle 语义将其删除即可，
      // 不应向用户返回 409 错误。
      if ((error as NodeJS.ErrnoException).code === "ER_DUP_ENTRY") {
        await getDb().prepare(`DELETE FROM ${table} WHERE user_id=? AND document_id=?`)
          .run(user.id, id);
        return false;
      }
      throw error;
    }
  });
  const count = (
    await getDb()
      .prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE document_id=?`)
      .get(id)
  )!.count;
  response.json({ active, count: Number(count) });
}

async function setLike(request: AuthRequest, response: Response, active: boolean): Promise<void> {
  const id = numberId(request.params.id);
  const user = userOf(request);
  await canAccessDocument(id, user);
  if (active) {
    await getDb().prepare(
      `INSERT INTO likes(user_id,document_id,created_at) VALUES (?,?,?)
       ON DUPLICATE KEY UPDATE created_at=created_at`,
    ).run(user.id, id, nowIso());
  } else {
    await getDb().prepare("DELETE FROM likes WHERE user_id=? AND document_id=?")
      .run(user.id, id);
  }
  const row = await getDb().prepare("SELECT COUNT(*) AS count FROM likes WHERE document_id=?").get(id);
  response.json({ active, count: Number(row?.count ?? 0) });
}

export function createInteractionsRouter(): Router {
  const router = Router();
  router.use(requireUser);

  router.post("/documents/:id/favorite", (request: AuthRequest, response) =>
    toggleRelation("favorites", request, response),
  );

  router.post("/documents/:id/like", (request: AuthRequest, response) =>
    toggleRelation("likes", request, response),
  );
  router.put("/documents/:id/like", (request: AuthRequest, response) =>
    setLike(request, response, true),
  );
  router.delete("/documents/:id/like", (request: AuthRequest, response) =>
    setLike(request, response, false),
  );

  router.get("/documents/:id/comments", async (request: AuthRequest, response) => {
    const id = numberId(request.params.id);
    await canAccessDocument(id, userOf(request));
    response.json(
      await getDb()
        .prepare(
          `SELECT c.*,u.username FROM comments c
           JOIN users u ON u.id=c.user_id
           WHERE c.document_id=? ORDER BY c.created_at DESC`,
        )
        .all(id),
    );
  });

  router.post("/documents/:id/comments", async (request: AuthRequest, response) => {
    const id = numberId(request.params.id);
    const user = userOf(request);
    await canAccessDocument(id, user);
    const content = text(request.body?.content, "评论", 500);
    const result = await getDb()
      .prepare(
        `INSERT INTO comments(user_id,document_id,content,created_at)
         VALUES (?,?,?,?)`,
      )
      .run(user.id, id, content, nowIso());
    response.status(201).json(
      await getDb()
        .prepare(
          `SELECT c.*,u.username FROM comments c
           JOIN users u ON u.id=c.user_id WHERE c.id=?`,
        )
        .get(result.lastInsertRowid),
    );
  });

  router.delete("/comments/:id", async (request: AuthRequest, response) => {
    const id = numberId(request.params.id);
    const user = userOf(request);
    const row = (await getDb()
      .prepare("SELECT * FROM comments WHERE id=?")
      .get(id)) as SqlRow | undefined;
    if (!row) throw new ApiError(404, "评论不存在");
    if (
      Number(row.user_id) !== user.id &&
      !["department_admin", "system_admin"].includes(user.role)
    ) {
      throw new ApiError(403, "无权删除该评论");
    }
    await getDb().prepare("DELETE FROM comments WHERE id=?").run(id);
    response.status(204).end();
  });

  router.post("/documents/:id/share", async (request: AuthRequest, response) => {
    const id = numberId(request.params.id);
    await canAccessDocument(id, userOf(request), true);
    await getDb()
      .prepare(
        `UPDATE documents
         SET share_status='pending',share_note='',updated_at=? WHERE id=?`,
      )
      .run(nowIso(), id);
    response.json({ ok: true, message: "已提交共享审核" });
  });

  router.delete("/documents/:id/share", async (request: AuthRequest, response) => {
    const id = numberId(request.params.id);
    await canAccessDocument(id, userOf(request), true);
    await getDb()
      .prepare(
        `UPDATE documents
         SET share_status='private',share_note='',updated_at=? WHERE id=?`,
      )
      .run(nowIso(), id);
    response.status(204).end();
  });

  return router;
}
