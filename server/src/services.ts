import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { hashPassword } from "./auth.js";
import {
  allowedExtensions,
  defaultAdminPassword,
  uploadDirectory,
} from "./config.js";
import { ApiError, tagsFromJson } from "./core.js";
import { getDb, nowIso } from "./db.js";
import { chunkText } from "./documents.js";
import { lexicalScore, queryTerms } from "./search.js";
import type {
  AuthRequest,
  SearchHit,
  SqlRow,
  User,
} from "./types.js";

export async function seedAdmin(): Promise<void> {
  const db = getDb();
  if (!(await db.prepare("SELECT id FROM users WHERE username='admin'").get())) {
    await db.prepare(
      `INSERT INTO users(username,email,password_hash,role,created_at)
       VALUES (?,?,?,?,?)`,
    ).run(
      "admin",
      "admin@local.test",
      hashPassword(defaultAdminPassword),
      "system_admin",
      nowIso(),
    );
  }
}

export function userOf(request: AuthRequest): User {
  if (!request.user) throw new ApiError(401, "请先登录");
  return request.user;
}

export async function canAccessKnowledgeBase(
  id: number,
  user: User,
  write = false,
): Promise<SqlRow> {
  const row = await getDb()
    .prepare("SELECT * FROM knowledge_bases WHERE id=?")
    .get(id) as SqlRow | undefined;
  if (!row) throw new ApiError(404, "知识库不存在");
  if (
    Number(row.owner_id) === user.id ||
    ["department_admin", "system_admin"].includes(user.role)
  ) {
    return row;
  }
  if (!write && ["shared", "public"].includes(String(row.visibility))) {
    return row;
  }
  throw new ApiError(403, "无权访问该知识库");
}

export async function canAccessDocument(
  id: number,
  user: User,
  write = false,
): Promise<SqlRow> {
  const row = await getDb()
    .prepare("SELECT * FROM documents WHERE id=?")
    .get(id) as SqlRow | undefined;
  if (!row) throw new ApiError(404, "文档不存在");
  if (
    Number(row.owner_id) === user.id ||
    ["department_admin", "system_admin"].includes(user.role)
  ) {
    return row;
  }
  if (!write && row.share_status === "shared") return row;
  throw new ApiError(403, "无权访问该文档");
}

export function accessibleDocumentWhere(
  user: User,
  alias = "d",
): { sql: string; params: Array<string | number> } {
  if (["department_admin", "system_admin"].includes(user.role)) {
    return { sql: "1=1", params: [] };
  }
  return {
    sql: `(${alias}.owner_id=? OR ${alias}.share_status='shared')`,
    params: [user.id],
  };
}

export const documentSelect = `
  SELECT d.*,u.username AS owner_name,
    EXISTS(SELECT 1 FROM favorites f
      WHERE f.document_id=d.id AND f.user_id=?) AS favorite,
    EXISTS(SELECT 1 FROM likes mine
      WHERE mine.document_id=d.id AND mine.user_id=?) AS liked,
    (SELECT COUNT(*) FROM likes l WHERE l.document_id=d.id) AS like_count,
    (SELECT COUNT(*) FROM favorites f2 WHERE f2.document_id=d.id) AS favorite_count,
    (SELECT COUNT(*) FROM comments c WHERE c.document_id=d.id) AS comment_count,
    (SELECT COUNT(*) FROM kb_documents kd WHERE kd.document_id=d.id) AS knowledge_base_count
  FROM documents d JOIN users u ON u.id=d.owner_id
`;

export async function replaceChunks(
  documentId: number,
  content: string,
): Promise<number> {
  const chunks = chunkText(content);
  if (!chunks.length) {
    throw new ApiError(
      400,
      "文档中没有可提取的文字；扫描版 PDF 请先进行 OCR",
    );
  }
  const db = getDb();
  await db
    .prepare("DELETE FROM document_chunks WHERE document_id=?")
    .run(documentId);
  const insert = db.prepare(
    "INSERT INTO document_chunks(document_id,chunk_index,content) VALUES (?,?,?)",
  );
  for (const [index, chunk] of chunks.entries()) {
    await insert.run(documentId, index, chunk);
  }
  return chunks.length;
}

export async function persistUpload(
  file: Express.Multer.File,
): Promise<{ storedPath: string; extension: string }> {
  const extension = path.extname(file.originalname).toLowerCase();
  if (!allowedExtensions.has(extension)) {
    throw new ApiError(415, "仅支持 PDF、DOCX、TXT、Markdown 文件");
  }
  const storedPath = path.join(
    uploadDirectory,
    `${crypto.randomUUID().replaceAll("-", "")}${extension}`,
  );
  await fsp.writeFile(storedPath, file.buffer);
  return { storedPath, extension };
}

export async function searchChunks(
  user: User,
  query: string,
  options: {
    knowledgeBaseId?: number;
    category?: string;
    tag?: string;
    limit?: number;
  } = {},
): Promise<SearchHit[]> {
  const access = accessibleDocumentWhere(user);
  const clauses = [access.sql];
  const parameters: Array<string | number> = [...access.params];
  let join = "";
  if (options.knowledgeBaseId) {
    await canAccessKnowledgeBase(options.knowledgeBaseId, user);
    join = "JOIN kb_documents kd ON kd.document_id=d.id";
    clauses.push("kd.knowledge_base_id=?");
    parameters.push(options.knowledgeBaseId);
  }
  if (options.category) {
    clauses.push("d.category=?");
    parameters.push(options.category);
  }
  if (options.tag) {
    clauses.push("d.tags LIKE ?");
    parameters.push(`%"${options.tag}"%`);
  }
  const terms = queryTerms(query).slice(0, 4);
  if (terms.length) {
    clauses.push(
      `(${terms
        .map(() => "(c.content LIKE ? OR d.title LIKE ? OR d.tags LIKE ?)")
        .join(" OR ")})`,
    );
    for (const term of terms) {
      parameters.push(`%${term}%`, `%${term}%`, `%${term}%`);
    }
  }
  const rows = await getDb()
    .prepare(
      `SELECT c.id AS chunk_id,c.chunk_index,c.content,
        d.id AS document_id,d.title,d.category,d.tags,d.updated_at
       FROM document_chunks c JOIN documents d ON d.id=c.document_id
       ${join} WHERE ${clauses.join(" AND ")}`,
    )
    .all(...parameters) as SqlRow[];
  return rows
    .map((row) => ({
      chunk_id: Number(row.chunk_id),
      chunk_index: Number(row.chunk_index),
      document_id: Number(row.document_id),
      title: String(row.title),
      category: String(row.category),
      tags: tagsFromJson(row.tags),
      content: String(row.content),
      score: Number(
        lexicalScore(
          query,
          String(row.content),
          String(row.title),
          String(row.tags),
        ).toFixed(4),
      ),
    }))
    .filter((row) => row.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, options.limit ?? 12);
}
