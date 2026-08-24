import { Router } from "express";
import {
  createSession,
  hashPassword,
  publicUser,
  requireUser,
  tokenHashFromRequest,
  verifyPassword,
} from "../auth.js";
import { ApiError, optionalText, text } from "../core.js";
import { getDb, nowIso } from "../db.js";
import { userOf } from "../services.js";
import type { AuthRequest, SqlRow } from "../types.js";

export function createAuthRouter(): Router {
  const router = Router();

  router.post("/register", async (request, response) => {
    const username = text(request.body?.username, "用户名", 32);
    const password = text(request.body?.password, "密码", 128);
    if (password.length < 6) throw new ApiError(400, "密码至少需要 6 位");
    const email = optionalText(request.body?.email, 120) || null;
    const phone = optionalText(request.body?.phone, 30) || null;
    const db = getDb();
    const duplicate = await db
      .prepare(
        `SELECT id FROM users WHERE username=?
         OR (? IS NOT NULL AND email=?) OR (? IS NOT NULL AND phone=?)`,
      )
      .get(username, email, email, phone, phone);
    if (duplicate) throw new ApiError(409, "用户名、邮箱或手机号已被使用");
    const result = await db
      .prepare(
        `INSERT INTO users(username,email,phone,password_hash,role,created_at)
         VALUES (?,?,?,?,?,?)`,
      )
      .run(username, email, phone, hashPassword(password), "user", nowIso());
    const row = (await db
      .prepare("SELECT * FROM users WHERE id=?")
      .get(result.lastInsertRowid)) as SqlRow;
    response
      .status(201)
      .json({ token: await createSession(Number(row.id)), user: publicUser(row) });
  });

  router.post("/login", async (request, response) => {
    const account = text(request.body?.account, "账号", 120);
    const password = text(request.body?.password, "密码", 128);
    const row = (await getDb()
      .prepare("SELECT * FROM users WHERE username=? OR email=? OR phone=?")
      .get(account, account, account)) as SqlRow | undefined;
    if (!row || !verifyPassword(password, String(row.password_hash))) {
      throw new ApiError(401, "账号或密码错误");
    }
    response.json({
      token: await createSession(Number(row.id)),
      user: publicUser(row),
    });
  });

  router.post("/logout", requireUser, async (request: AuthRequest, response) => {
    const tokenHash = tokenHashFromRequest(request);
    if (tokenHash) {
      await getDb()
        .prepare("DELETE FROM auth_sessions WHERE token_hash=?")
        .run(tokenHash);
    }
    response.status(204).end();
  });

  router.get("/me", requireUser, (request: AuthRequest, response) => {
    response.json(userOf(request));
  });

  return router;
}
