import {
  createHash,
  pbkdf2Sync,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import type { NextFunction, Response } from "express";
import { sessionHours } from "./config.js";
import { getDb, nowIso } from "./db.js";
import type {
  AuthRequest,
  User,
  UserRole,
  UserRow,
} from "./types.js";

const iterations = 310_000;

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const digest = pbkdf2Sync(password, salt, iterations, 32, "sha256");
  return `pbkdf2_sha256$${iterations}$${salt.toString("hex")}$${digest.toString("hex")}`;
}

export function verifyPassword(password: string, encoded: string): boolean {
  try {
    const [, count, saltHex, digestHex] = encoded.split("$");
    const actual = pbkdf2Sync(
      password,
      Buffer.from(saltHex, "hex"),
      Number(count),
      32,
      "sha256",
    );
    return timingSafeEqual(actual, Buffer.from(digestHex, "hex"));
  } catch {
    return false;
  }
}

export function publicUser(row: UserRow | Record<string, unknown>): User {
  return {
    id: Number(row.id),
    username: String(row.username),
    email: row.email ? String(row.email) : null,
    phone: row.phone ? String(row.phone) : null,
    role: String(row.role) as UserRole,
    created_at: String(row.created_at),
  };
}

export async function createSession(userId: number): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const expiresAt = new Date(
    Date.now() + sessionHours * 60 * 60 * 1000,
  ).toISOString();
  await getDb()
    .prepare(
      `INSERT INTO auth_sessions(token_hash,user_id,expires_at,created_at)
       VALUES (?,?,?,?)`,
    )
    .run(tokenHash, userId, expiresAt, nowIso());
  return token;
}

export function tokenHashFromRequest(request: AuthRequest): string | null {
  const header = request.headers.authorization ?? "";
  if (!header.toLowerCase().startsWith("bearer ")) return null;
  const token = header.slice(7).trim();
  return token ? createHash("sha256").update(token).digest("hex") : null;
}

export async function requireUser(
  request: AuthRequest,
  response: Response,
  next: NextFunction,
): Promise<void> {
  const tokenHash = tokenHashFromRequest(request);
  if (!tokenHash) {
    response.status(401).json({ message: "请先登录" });
    return;
  }
  const row = await getDb()
    .prepare(
      `SELECT u.id,u.username,u.email,u.phone,u.role,u.created_at
       FROM auth_sessions s JOIN users u ON u.id=s.user_id
       WHERE s.token_hash=? AND s.expires_at>?`,
    )
    .get(tokenHash, nowIso()) as Record<string, unknown> | undefined;
  if (!row) {
    response.status(401).json({ message: "登录已失效，请重新登录" });
    return;
  }
  request.user = publicUser(row);
  next();
}

export async function requireAdmin(
  request: AuthRequest,
  response: Response,
  next: NextFunction,
): Promise<void> {
  await requireUser(request, response, () => {
    if (
      !request.user ||
      !["department_admin", "system_admin"].includes(request.user.role)
    ) {
      response.status(403).json({ message: "需要管理员权限" });
      return;
    }
    next();
  });
}

export async function requireSystemAdmin(
  request: AuthRequest,
  response: Response,
  next: NextFunction,
): Promise<void> {
  await requireUser(request, response, () => {
    if (request.user?.role !== "system_admin") {
      response.status(403).json({ message: "需要系统管理员权限" });
      return;
    }
    next();
  });
}
