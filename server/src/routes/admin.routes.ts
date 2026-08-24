import { Router } from "express";
import { requireAdmin, requireSystemAdmin } from "../auth.js";
import { ApiError, documentJson, numberId, optionalText } from "../core.js";
import { getDb, nowIso } from "../db.js";
import { documentSelect, userOf } from "../services.js";
import type { AuthRequest, SqlRow, UserRole } from "../types.js";

export function createAdminRouter(): Router {
  const router = Router();
  router.use(requireAdmin);

  router.get("/users", async (_request, response) => {
    const rows = await getDb()
      .prepare(
        `SELECT u.id,u.username,u.email,u.phone,u.role,u.created_at,
          (SELECT COUNT(*) FROM documents d WHERE d.owner_id=u.id) AS document_count
         FROM users u ORDER BY u.created_at DESC`,
      )
      .all();
    response.json(rows);
  });

  router.patch(
    "/users/:id/role",
    requireSystemAdmin,
    async (request: AuthRequest, response) => {
      const id = numberId(request.params.id);
      const role = request.body?.role as UserRole;
      if (!["user", "department_admin", "system_admin"].includes(role)) {
        throw new ApiError(400, "角色无效");
      }
      if (id === userOf(request).id && role !== "system_admin") {
        throw new ApiError(400, "不能移除自己的系统管理员角色");
      }
      const result = await getDb()
        .prepare("UPDATE users SET role=? WHERE id=?")
        .run(role, id);
      if (!result.changes) throw new ApiError(404, "用户不存在");
      response.json({ ok: true });
    },
  );

  router.get("/share-requests", async (_request, response) => {
    const rows = (await getDb()
      .prepare(
        `${documentSelect}
         WHERE d.share_status='pending' ORDER BY d.updated_at`,
      )
      .all(0, 0)) as SqlRow[];
    response.json(rows.map(documentJson));
  });

  router.post("/documents/:id/review", async (request, response) => {
    const id = numberId(request.params.id);
    const approved = request.body?.approved === true;
    const note = optionalText(request.body?.note, 300);
    const result = await getDb()
      .prepare(
        `UPDATE documents SET share_status=?,share_note=?,updated_at=?
         WHERE id=? AND share_status='pending'`,
      )
      .run(approved ? "shared" : "rejected", note, nowIso(), id);
    if (!result.changes) throw new ApiError(404, "待审核文档不存在");
    response.json({
      ok: true,
      share_status: approved ? "shared" : "rejected",
    });
  });

  return router;
}
