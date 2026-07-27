import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import cors from "cors";
import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";
import multer from "multer";
import {
  createSession,
  hashPassword,
  publicUser,
  requireAdmin,
  requireSystemAdmin,
  requireUser,
  tokenHashFromRequest,
  verifyPassword,
} from "./auth.js";
import {
  frontendDist,
  maxUploadBytes,
} from "./config.js";
import {
  ApiError,
  documentJson,
  numberId,
  optionalText,
  parseTags,
  tagsFromJson,
  text,
} from "./core.js";
import {
  databaseInfo,
  getDb,
  initDb,
  nowIso,
  transaction,
} from "./db.js";
import {
  extractText,
  normalizeUploadFilename,
} from "./documents.js";
import {
  embeddingModelEnabled,
  embeddingModelName,
  embeddingStats,
  indexDocumentEmbeddings,
} from "./embeddings.js";
import {
  answerWithOllama,
  localModelEnabled,
  localModelName,
  ollamaBaseUrl,
} from "./ollama.js";
import { extractiveAnswer, toCitations } from "./search.js";
import {
  accessibleDocumentWhere,
  canAccessDocument,
  canAccessKnowledgeBase,
  documentSelect,
  persistUpload,
  replaceChunks,
  searchChunks,
  seedAdmin,
  userOf,
} from "./services.js";
import type {
  AuthRequest,
  SqlRow,
  UserRole,
} from "./types.js";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: maxUploadBytes },
});

export async function createApp() {
  await initDb();
  await seedAdmin();
  const app = express();
  app.use(cors({ origin: true, credentials: true }));
  app.use(express.json({ limit: "1mb" }));

  app.get("/api/health", async (_request, response) => {
    const mysql = await databaseInfo();
    const modelEnabled = localModelEnabled();
    const embeddingsEnabled = embeddingModelEnabled();
    const embeddingIndex = embeddingsEnabled
      ? await embeddingStats()
      : null;
    const modelServer = ollamaBaseUrl();
    const remoteModelConfigured =
      (modelEnabled || embeddingsEnabled) &&
      !/^https?:\/\/(?:127\.0\.0\.1|localhost)(?::|\/|$)/u.test(modelServer);
    response.json({
      status: "ok",
      app: "智知",
      database: "mysql",
      database_name: mysql.database,
      database_version: mysql.version,
      answer_engine: modelEnabled ? "local-qwen3-rag" : "local-extractive",
      local_model_configured: modelEnabled,
      local_model: modelEnabled ? localModelName() : null,
      retrieval_engine: embeddingsEnabled
        ? "hybrid-vector-lexical"
        : "lexical",
      embedding_model_configured: embeddingsEnabled,
      embedding_model: embeddingsEnabled ? embeddingModelName() : null,
      embedding_index: embeddingIndex,
      remote_model_configured: remoteModelConfigured,
    });
  });

  app.post("/api/auth/register", async (request, response) => {
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
    const id = Number(result.lastInsertRowid);
    const row = (await db
      .prepare("SELECT * FROM users WHERE id=?")
      .get(id)) as SqlRow;
    response
      .status(201)
      .json({ token: await createSession(id), user: publicUser(row) });
  });

  app.post("/api/auth/login", async (request, response) => {
    const account = text(request.body?.account, "账号", 120);
    const password = text(request.body?.password, "密码", 128);
    const row = (await getDb()
      .prepare(
        "SELECT * FROM users WHERE username=? OR email=? OR phone=?",
      )
      .get(account, account, account)) as SqlRow | undefined;
    if (!row || !verifyPassword(password, String(row.password_hash))) {
      throw new ApiError(401, "账号或密码错误");
    }
    response.json({
      token: await createSession(Number(row.id)),
      user: publicUser(row),
    });
  });

  app.post(
    "/api/auth/logout",
    requireUser,
    async (request: AuthRequest, response) => {
      const tokenHash = tokenHashFromRequest(request);
      if (tokenHash) {
        await getDb()
          .prepare("DELETE FROM auth_sessions WHERE token_hash=?")
          .run(tokenHash);
      }
      response.status(204).end();
    },
  );

  app.get(
    "/api/auth/me",
    requireUser,
    async (request: AuthRequest, response) => {
      response.json(userOf(request));
    },
  );

  app.get("/api/admin/users", requireAdmin, async (_request, response) => {
    const rows = await getDb()
      .prepare(
        `SELECT u.id,u.username,u.email,u.phone,u.role,u.created_at,
          (SELECT COUNT(*) FROM documents d WHERE d.owner_id=u.id) AS document_count
         FROM users u ORDER BY u.created_at DESC`,
      )
      .all();
    response.json(rows);
  });

  app.patch(
    "/api/admin/users/:id/role",
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

  app.get(
    "/api/knowledge-bases",
    requireUser,
    async (request: AuthRequest, response) => {
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
    },
  );

  app.post(
    "/api/knowledge-bases",
    requireUser,
    async (request: AuthRequest, response) => {
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
          .run(
            user.id,
            name,
            description,
            visibility,
            timestamp,
            timestamp,
          );
        const row = await getDb()
          .prepare("SELECT * FROM knowledge_bases WHERE id=?")
          .get(result.lastInsertRowid);
        response.status(201).json(row);
      } catch (error) {
        if (
          (error as { code?: string }).code === "ER_DUP_ENTRY" ||
          String(error).includes("UNIQUE")
        ) {
          throw new ApiError(409, "你已有同名知识库");
        }
        throw error;
      }
    },
  );

  app.put(
    "/api/knowledge-bases/:id",
    requireUser,
    async (request: AuthRequest, response) => {
      const id = numberId(request.params.id);
      const user = userOf(request);
      await canAccessKnowledgeBase(id, user, true);
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
    },
  );

  app.delete(
    "/api/knowledge-bases/:id",
    requireUser,
    async (request: AuthRequest, response) => {
      const id = numberId(request.params.id);
      await canAccessKnowledgeBase(id, userOf(request), true);
      await getDb().prepare("DELETE FROM knowledge_bases WHERE id=?").run(id);
      response.status(204).end();
    },
  );

  app.post(
    "/api/knowledge-bases/:id/documents",
    requireUser,
    async (request: AuthRequest, response) => {
      const id = numberId(request.params.id);
      const documentId = Number(request.body?.document_id);
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
    },
  );

  app.delete(
    "/api/knowledge-bases/:id/documents/:documentId",
    requireUser,
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

  app.get(
    "/api/documents",
    requireUser,
    async (request: AuthRequest, response) => {
      const user = userOf(request);
      const access = accessibleDocumentWhere(user);
      const clauses = [access.sql];
      const parameters: Array<string | number> = [...access.params];
      let join = "";
      const category =
        typeof request.query.category === "string"
          ? request.query.category
          : undefined;
      const tag =
        typeof request.query.tag === "string" ? request.query.tag : undefined;
      const knowledgeBaseId = request.query.knowledge_base_id
        ? Number(request.query.knowledge_base_id)
        : undefined;
      const scope = String(request.query.scope ?? "all");
      const sort = String(request.query.sort ?? "updated");
      if (category) {
        clauses.push("d.category=?");
        parameters.push(category);
      }
      if (tag) {
        clauses.push("d.tags LIKE ?");
        parameters.push(`%"${tag}"%`);
      }
      if (knowledgeBaseId) {
        await canAccessKnowledgeBase(knowledgeBaseId, user);
        join += " JOIN kb_documents kd ON kd.document_id=d.id";
        clauses.push("kd.knowledge_base_id=?");
        parameters.push(knowledgeBaseId);
      }
      if (scope === "mine") {
        clauses.push("d.owner_id=?");
        parameters.push(user.id);
      } else if (scope === "favorites") {
        join +=
          " JOIN favorites selected_f ON selected_f.document_id=d.id";
        clauses.push("selected_f.user_id=?");
        parameters.push(user.id);
      } else if (scope === "shared") {
        clauses.push("d.share_status='shared'");
      }
      const order =
        sort === "latest"
          ? "d.created_at DESC"
          : sort === "hot"
            ? `(d.views+d.downloads*2+
                (SELECT COUNT(*)*3 FROM likes l WHERE l.document_id=d.id)) DESC`
            : "d.updated_at DESC";
      const rows = (await getDb()
        .prepare(
          `${documentSelect} ${join}
           WHERE ${clauses.join(" AND ")} ORDER BY ${order}`,
        )
        .all(user.id, user.id, ...parameters)) as SqlRow[];
      response.json(rows.map(documentJson));
    },
  );

  app.post(
    "/api/documents",
    requireUser,
    upload.single("file"),
    async (request: AuthRequest, response) => {
      if (!request.file) throw new ApiError(400, "请选择上传文件");
      const user = userOf(request);
      const originalName = path.basename(
        normalizeUploadFilename(request.file.originalname),
      );
      const { storedPath, extension } = await persistUpload(
        request.file,
        originalName,
      );
      try {
        const content = (await extractText(storedPath, extension)).trim();
        const title =
          optionalText(request.body?.title, 150) ||
          path.basename(originalName, extension);
        const category =
          optionalText(request.body?.category, 50) || "未分类";
        const tags = parseTags(request.body?.tags);
        const knowledgeBaseId = request.body?.knowledge_base_id
          ? Number(request.body.knowledge_base_id)
          : undefined;
        if (knowledgeBaseId) {
          await canAccessKnowledgeBase(knowledgeBaseId, user, true);
        }
        const timestamp = nowIso();
        const created = await transaction(async () => {
          const result = await getDb()
            .prepare(
              `INSERT INTO documents(
                owner_id,title,filename,stored_path,file_type,file_size,
                category,tags,text_content,status,created_at,updated_at
               ) VALUES (?,?,?,?,?,?,?,?,?,'ready',?,?)`,
            )
            .run(
              user.id,
              title,
              originalName,
              storedPath,
              extension.slice(1).toUpperCase(),
              request.file!.size,
              category,
              JSON.stringify(tags),
              content,
              timestamp,
              timestamp,
            );
          const documentId = Number(result.lastInsertRowid);
          await getDb()
            .prepare(
              `INSERT INTO document_versions(
                document_id,version,filename,stored_path,file_size,created_at
               ) VALUES (?,1,?,?,?,?)`,
            )
            .run(
              documentId,
              originalName,
              storedPath,
              request.file!.size,
              timestamp,
            );
          const chunkCount = await replaceChunks(documentId, content);
          if (knowledgeBaseId) {
            await getDb()
              .prepare(
                `INSERT INTO kb_documents(
                  knowledge_base_id,document_id,added_at
                 ) VALUES (?,?,?)`,
              )
              .run(knowledgeBaseId, documentId, timestamp);
          }
          return { documentId, chunkCount };
        });
        const row = (await getDb()
          .prepare(`${documentSelect} WHERE d.id=?`)
          .get(user.id, user.id, created.documentId)) as SqlRow;
        let embeddedChunkCount = 0;
        if (embeddingModelEnabled()) {
          try {
            embeddedChunkCount = await indexDocumentEmbeddings(
              created.documentId,
            );
          } catch (error) {
            console.warn(
              "Document embedding failed; lexical search remains available:",
              error instanceof Error ? error.message : error,
            );
          }
        }
        response
          .status(201)
          .json({
            ...documentJson(row),
            chunk_count: created.chunkCount,
            embedded_chunk_count: embeddedChunkCount,
          });
      } catch (error) {
        await fsp.rm(storedPath, { force: true });
        throw error;
      }
    },
  );

  app.get(
    "/api/documents/:id",
    requireUser,
    async (request: AuthRequest, response) => {
      const id = numberId(request.params.id);
      const user = userOf(request);
      await canAccessDocument(id, user);
      await getDb()
        .prepare("UPDATE documents SET views=views+1 WHERE id=?")
        .run(id);
      const row = (await getDb()
        .prepare(`${documentSelect} WHERE d.id=?`)
        .get(user.id, user.id, id)) as SqlRow;
      const knowledgeBases = await getDb()
        .prepare(
          `SELECT k.id,k.name FROM knowledge_bases k
           JOIN kb_documents kd ON kd.knowledge_base_id=k.id
           WHERE kd.document_id=? ORDER BY k.name`,
        )
        .all(id);
      const versions = await getDb()
        .prepare(
          `SELECT id,version,filename,file_size,created_at
           FROM document_versions WHERE document_id=?
           ORDER BY version DESC`,
        )
        .all(id);
      response.json({
        ...documentJson(row),
        knowledge_bases: knowledgeBases,
        versions,
      });
    },
  );

  app.put(
    "/api/documents/:id",
    requireUser,
    async (request: AuthRequest, response) => {
      const id = numberId(request.params.id);
      const user = userOf(request);
      await canAccessDocument(id, user, true);
      const title = text(request.body?.title, "文档标题", 150);
      const category =
        optionalText(request.body?.category, 50) || "未分类";
      const tags = parseTags(request.body?.tags);
      await getDb()
        .prepare(
          `UPDATE documents SET title=?,category=?,tags=?,updated_at=?
           WHERE id=?`,
        )
        .run(title, category, JSON.stringify(tags), nowIso(), id);
      const row = (await getDb()
        .prepare(`${documentSelect} WHERE d.id=?`)
        .get(user.id, user.id, id)) as SqlRow;
      response.json(documentJson(row));
    },
  );

  app.post(
    "/api/documents/:id/versions",
    requireUser,
    upload.single("file"),
    async (request: AuthRequest, response) => {
      if (!request.file) throw new ApiError(400, "请选择版本文件");
      const id = numberId(request.params.id);
      const user = userOf(request);
      const current = await canAccessDocument(id, user, true);
      const originalName = path.basename(
        normalizeUploadFilename(request.file.originalname),
      );
      const { storedPath, extension } = await persistUpload(
        request.file,
        originalName,
      );
      try {
        const content = (await extractText(storedPath, extension)).trim();
        const nextVersion = Number(current.version) + 1;
        const chunkCount = await transaction(async () => {
          const count = await replaceChunks(id, content);
          const timestamp = nowIso();
          await getDb()
            .prepare(
              `UPDATE documents SET filename=?,stored_path=?,file_type=?,
                file_size=?,version=?,text_content=?,updated_at=? WHERE id=?`,
            )
            .run(
              originalName,
              storedPath,
              extension.slice(1).toUpperCase(),
              request.file!.size,
              nextVersion,
              content,
              timestamp,
              id,
            );
          await getDb()
            .prepare(
              `INSERT INTO document_versions(
                document_id,version,filename,stored_path,file_size,created_at
               ) VALUES (?,?,?,?,?,?)`,
            )
            .run(
              id,
              nextVersion,
              originalName,
              storedPath,
              request.file!.size,
              timestamp,
            );
          return count;
        });
        let embeddedChunkCount = 0;
        if (embeddingModelEnabled()) {
          try {
            embeddedChunkCount = await indexDocumentEmbeddings(id);
          } catch (error) {
            console.warn(
              "Document embedding failed; lexical search remains available:",
              error instanceof Error ? error.message : error,
            );
          }
        }
        response
          .status(201)
          .json({
            ok: true,
            version: nextVersion,
            chunk_count: chunkCount,
            embedded_chunk_count: embeddedChunkCount,
          });
      } catch (error) {
        await fsp.rm(storedPath, { force: true });
        throw error;
      }
    },
  );

  app.delete(
    "/api/documents/:id",
    requireUser,
    async (request: AuthRequest, response) => {
      const id = numberId(request.params.id);
      await canAccessDocument(id, userOf(request), true);
      const paths = (
        await getDb()
          .prepare(
            "SELECT stored_path FROM document_versions WHERE document_id=?",
          )
          .all(id)
      ).map((row) => String(row.stored_path));
      await getDb().prepare("DELETE FROM documents WHERE id=?").run(id);
      await Promise.all(
        [...new Set(paths)].map((file) => fsp.rm(file, { force: true })),
      );
      response.status(204).end();
    },
  );

  app.get(
    "/api/documents/:id/preview",
    requireUser,
    async (request: AuthRequest, response) => {
      const id = numberId(request.params.id);
      const row = await canAccessDocument(id, userOf(request));
      await getDb()
        .prepare("UPDATE documents SET views=views+1 WHERE id=?")
        .run(id);
      response.type(String(row.file_type).toLowerCase());
      response.setHeader(
        "Content-Disposition",
        `inline; filename*=UTF-8''${encodeURIComponent(String(row.filename))}`,
      );
      response.sendFile(path.resolve(String(row.stored_path)));
    },
  );

  app.get(
    "/api/documents/:id/download",
    requireUser,
    async (request: AuthRequest, response) => {
      const id = numberId(request.params.id);
      const row = await canAccessDocument(id, userOf(request));
      await getDb()
        .prepare("UPDATE documents SET downloads=downloads+1 WHERE id=?")
        .run(id);
      response.download(String(row.stored_path), String(row.filename));
    },
  );

  app.get(
    "/api/documents/:id/versions/:versionId/download",
    requireUser,
    async (request: AuthRequest, response) => {
      const id = numberId(request.params.id);
      await canAccessDocument(id, userOf(request));
      const row = (await getDb()
        .prepare(
          `SELECT * FROM document_versions
           WHERE id=? AND document_id=?`,
        )
        .get(numberId(request.params.versionId), id)) as SqlRow | undefined;
      if (!row) throw new ApiError(404, "历史版本不存在");
      response.download(String(row.stored_path), String(row.filename));
    },
  );

  app.get(
    "/api/search",
    requireUser,
    async (request: AuthRequest, response) => {
      const query = text(request.query.q, "检索词", 500);
      const knowledgeBaseId = request.query.knowledge_base_id
        ? Number(request.query.knowledge_base_id)
        : undefined;
      const limit = Math.min(50, Math.max(1, Number(request.query.limit ?? 12)));
      const results = await searchChunks(userOf(request), query, {
        knowledgeBaseId,
        category:
          typeof request.query.category === "string"
            ? request.query.category
            : undefined,
        tag:
          typeof request.query.tag === "string"
            ? request.query.tag
            : undefined,
        limit,
      });
      await getDb()
        .prepare(
          `INSERT INTO search_logs(user_id,query,mode,created_at)
           VALUES (?,?,'fulltext',?)`,
        )
        .run(userOf(request).id, query, nowIso());
      response.json({ query, mode: "fulltext", results });
    },
  );

  app.get(
    "/api/documents/:id/recommendations",
    requireUser,
    async (request: AuthRequest, response) => {
      const id = numberId(request.params.id);
      const user = userOf(request);
      const source = await canAccessDocument(id, user);
      const access = accessibleDocumentWhere(user, "candidate");
      const tags = tagsFromJson(source.tags);
      const rows = (await getDb()
        .prepare(
          `SELECT candidate.id,candidate.title,candidate.category,candidate.tags,
             candidate.views,candidate.downloads,
             CASE WHEN candidate.category=? THEN 3 ELSE 0 END
             + CASE WHEN candidate.tags LIKE ? THEN 2 ELSE 0 END AS relevance
           FROM documents candidate
           WHERE candidate.id<>? AND ${access.sql}
           ORDER BY relevance DESC,candidate.views DESC,candidate.updated_at DESC
           LIMIT 6`,
        )
        .all(
          String(source.category),
          tags.length ? `%"${tags[0]}"%` : "[]",
          id,
          ...access.params,
        )) as SqlRow[];
      response.json(
        rows.map((row) => ({ ...row, tags: tagsFromJson(row.tags) })),
      );
    },
  );

  app.post(
    "/api/chat/ask",
    requireUser,
    async (request: AuthRequest, response) => {
      const user = userOf(request);
      const question = text(request.body?.question, "问题", 2_000);
      const knowledgeBaseId = request.body?.knowledge_base_id
        ? Number(request.body.knowledge_base_id)
        : undefined;
      const requestedSessionId = request.body?.session_id
        ? Number(request.body.session_id)
        : undefined;
      if (knowledgeBaseId) {
        await canAccessKnowledgeBase(knowledgeBaseId, user);
      }
      const contexts = await searchChunks(user, question, {
        knowledgeBaseId,
        limit: 5,
      });
      const citations = toCitations(contexts);
      let answer = extractiveAnswer(question, contexts);
      let engine = "local-extractive";
      if (localModelEnabled()) {
        try {
          answer = await answerWithOllama(question, contexts);
          engine = "local-qwen3-rag";
        } catch (error) {
          engine = "local-extractive-fallback";
          console.warn(
            "Ollama answer failed; using extractive fallback:",
            error instanceof Error ? error.message : error,
          );
        }
      }
      const timestamp = nowIso();
      const sessionId = await transaction(async () => {
        let id = requestedSessionId;
        if (id) {
          const session = await getDb()
            .prepare(
              "SELECT id FROM chat_sessions WHERE id=? AND user_id=?",
            )
            .get(id, user.id);
          if (!session) throw new ApiError(404, "问答会话不存在");
        } else {
          const result = await getDb()
            .prepare(
              `INSERT INTO chat_sessions(
                user_id,knowledge_base_id,title,created_at,updated_at
               ) VALUES (?,?,?,?,?)`,
            )
            .run(
              user.id,
              knowledgeBaseId ?? null,
              question.slice(0, 30),
              timestamp,
              timestamp,
            );
          id = Number(result.lastInsertRowid);
        }
        await getDb()
          .prepare(
            `INSERT INTO messages(
              session_id,role,content,citations,created_at
             ) VALUES (?,'user',?,'[]',?)`,
          )
          .run(id, question, timestamp);
        await getDb()
          .prepare(
            `INSERT INTO messages(
              session_id,role,content,citations,created_at
             ) VALUES (?,'assistant',?,?,?)`,
          )
          .run(id, answer, JSON.stringify(citations), timestamp);
        await getDb()
          .prepare("UPDATE chat_sessions SET updated_at=? WHERE id=?")
          .run(timestamp, id);
        await getDb()
          .prepare(
            `INSERT INTO search_logs(user_id,query,mode,created_at)
             VALUES (?,?,'question',?)`,
          )
          .run(user.id, question, timestamp);
        return id;
      });
      response.json({
        session_id: sessionId,
        answer,
        citations,
        engine,
      });
    },
  );

  app.get(
    "/api/chat/sessions",
    requireUser,
    async (request: AuthRequest, response) => {
      const rows = await getDb()
        .prepare(
          `SELECT s.*,k.name AS knowledge_base_name,
             (SELECT COUNT(*) FROM messages m WHERE m.session_id=s.id) AS message_count
           FROM chat_sessions s
           LEFT JOIN knowledge_bases k ON k.id=s.knowledge_base_id
           WHERE s.user_id=? ORDER BY s.updated_at DESC`,
        )
        .all(userOf(request).id);
      response.json(rows);
    },
  );

  app.get(
    "/api/chat/sessions/:id",
    requireUser,
    async (request: AuthRequest, response) => {
      const id = numberId(request.params.id);
      const session = (await getDb()
        .prepare(
          "SELECT * FROM chat_sessions WHERE id=? AND user_id=?",
        )
        .get(id, userOf(request).id)) as SqlRow | undefined;
      if (!session) throw new ApiError(404, "问答会话不存在");
      const messages = (
        await getDb()
          .prepare("SELECT * FROM messages WHERE session_id=? ORDER BY id")
          .all(id)
      ).map((row) => ({
        ...row,
        citations: JSON.parse(String(row.citations ?? "[]")),
      }));
      response.json({ session, messages });
    },
  );

  app.delete(
    "/api/chat/sessions/:id",
    requireUser,
    async (request: AuthRequest, response) => {
      const result = await getDb()
        .prepare("DELETE FROM chat_sessions WHERE id=? AND user_id=?")
        .run(numberId(request.params.id), userOf(request).id);
      if (!result.changes) throw new ApiError(404, "问答会话不存在");
      response.status(204).end();
    },
  );

  async function toggleRelation(
    table: "favorites" | "likes",
    request: AuthRequest,
    response: Response,
  ): Promise<void> {
    const id = numberId(request.params.id);
    const user = userOf(request);
    await canAccessDocument(id, user);
    const existing = await getDb()
      .prepare(`SELECT 1 FROM ${table} WHERE user_id=? AND document_id=?`)
      .get(user.id, id);
    if (existing) {
      await getDb()
        .prepare(`DELETE FROM ${table} WHERE user_id=? AND document_id=?`)
        .run(user.id, id);
    } else {
      await getDb()
        .prepare(
          `INSERT INTO ${table}(user_id,document_id,created_at)
           VALUES (?,?,?)`,
        )
        .run(user.id, id, nowIso());
    }
    const count = (
      await getDb()
        .prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE document_id=?`)
        .get(id)
    )!.count;
    response.json({ active: !existing, count: Number(count) });
  }

  app.post(
    "/api/documents/:id/favorite",
    requireUser,
    (request: AuthRequest, response) =>
      toggleRelation("favorites", request, response),
  );

  app.post(
    "/api/documents/:id/like",
    requireUser,
    (request: AuthRequest, response) =>
      toggleRelation("likes", request, response),
  );

  app.get(
    "/api/documents/:id/comments",
    requireUser,
    async (request: AuthRequest, response) => {
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
    },
  );

  app.post(
    "/api/documents/:id/comments",
    requireUser,
    async (request: AuthRequest, response) => {
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
    },
  );

  app.delete(
    "/api/comments/:id",
    requireUser,
    async (request: AuthRequest, response) => {
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
    },
  );

  app.post(
    "/api/documents/:id/share",
    requireUser,
    async (request: AuthRequest, response) => {
      const id = numberId(request.params.id);
      await canAccessDocument(id, userOf(request), true);
      await getDb()
        .prepare(
          `UPDATE documents
           SET share_status='pending',share_note='',updated_at=? WHERE id=?`,
        )
        .run(nowIso(), id);
      response.json({ ok: true, message: "已提交共享审核" });
    },
  );

  app.delete(
    "/api/documents/:id/share",
    requireUser,
    async (request: AuthRequest, response) => {
      const id = numberId(request.params.id);
      await canAccessDocument(id, userOf(request), true);
      await getDb()
        .prepare(
          `UPDATE documents
           SET share_status='private',share_note='',updated_at=? WHERE id=?`,
        )
        .run(nowIso(), id);
      response.status(204).end();
    },
  );

  app.get(
    "/api/admin/share-requests",
    requireAdmin,
    async (_request, response) => {
      const rows = (await getDb()
        .prepare(
          `${documentSelect}
           WHERE d.share_status='pending' ORDER BY d.updated_at`,
        )
        .all(0, 0)) as SqlRow[];
      response.json(rows.map(documentJson));
    },
  );

  app.post(
    "/api/admin/documents/:id/review",
    requireAdmin,
    async (request, response) => {
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
    },
  );

  app.get(
    "/api/stats",
    requireUser,
    async (request: AuthRequest, response) => {
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
      const questions = (
        await getDb()
          .prepare(
            `SELECT COUNT(*) AS count FROM messages m
             JOIN chat_sessions s ON s.id=m.session_id
             WHERE s.user_id=? AND m.role='user'`,
          )
          .get(user.id)
      )!.count;
      const searches = (
        await getDb()
          .prepare(
            "SELECT COUNT(*) AS count FROM search_logs WHERE user_id=?",
          )
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
          `SELECT d.id,d.title,d.views,d.downloads,
             (SELECT COUNT(*) FROM likes l WHERE l.document_id=d.id) AS likes
           FROM documents d WHERE ${access.sql}
           ORDER BY (
             d.views+d.downloads*2+
             (SELECT COUNT(*)*3 FROM likes l WHERE l.document_id=d.id)
           ) DESC LIMIT 6`,
        )
        .all(...access.params);
      const latestDocuments = await getDb()
        .prepare(
          `SELECT d.id,d.title,d.category,d.created_at FROM documents d
           WHERE ${access.sql} ORDER BY d.created_at DESC LIMIT 6`,
        )
        .all(...access.params);
      response.json({
        documents: Number(totals.documents),
        knowledge_bases: Number(knowledgeBases),
        views: Number(totals.views),
        downloads: Number(totals.downloads),
        questions: Number(questions),
        searches: Number(searches),
        categories,
        hot_keywords: hotKeywords,
        search_trend: searchTrend,
        popular_documents: popularDocuments,
        latest_documents: latestDocuments,
      });
    },
  );

  if (fs.existsSync(frontendDist)) {
    app.use(express.static(frontendDist));
    app.get(/.*/, (_request, response) => {
      response.sendFile(path.join(frontendDist, "index.html"));
    });
  }

  app.use(
    (
      error: unknown,
      _request: Request,
      response: Response,
      _next: NextFunction,
    ) => {
      if (error instanceof multer.MulterError) {
        response.status(413).json({ message: "文件超过上传大小限制" });
        return;
      }
      if (error instanceof ApiError) {
        response.status(error.status).json({ message: error.message });
        return;
      }
      if (
        (error as { code?: string }).code === "ER_DUP_ENTRY" ||
        (error instanceof Error &&
          error.message.includes("UNIQUE constraint"))
      ) {
        response.status(409).json({ message: "数据已存在" });
        return;
      }
      console.error(error);
      response.status(500).json({
        message:
          error instanceof Error ? error.message : "服务器内部错误",
      });
    },
  );
  return app;
}
