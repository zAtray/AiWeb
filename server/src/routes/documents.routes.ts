import fsp from "node:fs/promises";
import path from "node:path";
import { Router } from "express";
import multer from "multer";
import { requireUser } from "../auth.js";
import { maxUploadBytes, resolveStoredPath } from "../config.js";
import {
  ApiError,
  documentJson,
  numberId,
  optionalText,
  parseTags,
  strictEnum,
  strictLimit,
} from "../core.js";
import { getDb, nowIso, transaction } from "../db.js";
import { extractDocument, normalizeUploadFilename } from "../documents.js";
import { queueDocumentEmbedding } from "../embedding-queue.js";
import {
  accessibleDocumentWhere,
  canAccessDocument,
  canAccessKnowledgeBase,
  documentSelect,
  persistUpload,
  replaceChunks,
  syncRagSearchDocument,
  userOf,
} from "../services.js";
import type { AuthRequest, SqlRow } from "../types.js";

const upload = multer({
  storage: multer.memoryStorage(),
  // Busboy marks a file as truncated when its size reaches the configured
  // limit. Reserve one sentinel byte so a file exactly at the advertised
  // maximum remains valid while the first byte over the limit is rejected.
  limits: { fileSize: maxUploadBytes + 1 },
});

async function extractUploadedDocument(storedPath: string, extension: string) {
  try {
    return await extractDocument(storedPath, extension);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(422, "文档解析失败，请确认文件没有损坏或加密");
  }
}

export function createDocumentsRouter(): Router {
  const router = Router();
  router.use(requireUser);

  router.get("/", async (request: AuthRequest, response) => {
    const user = userOf(request);
    const access = accessibleDocumentWhere(user);
    const clauses = [access.sql];
    const parameters: Array<string | number> = [...access.params];
    let join = "";
    const category =
      typeof request.query.category === "string" ? request.query.category : undefined;
    const tag = typeof request.query.tag === "string" ? request.query.tag : undefined;
    const knowledgeBaseId = request.query.knowledge_base_id
      ? numberId(request.query.knowledge_base_id)
      : undefined;
    const scope = strictEnum(request.query.scope, "scope", ["all", "mine", "favorites", "shared"] as const, "all");
    const sort = strictEnum(request.query.sort, "sort", ["updated", "latest", "hot"] as const, "updated");
    const limit = strictLimit(request.query.limit, 50, 100);
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
      join += " JOIN favorites selected_f ON selected_f.document_id=d.id";
      clauses.push("selected_f.user_id=?");
      parameters.push(user.id);
    } else if (scope === "shared") {
      clauses.push("d.share_status='shared'");
    }
    const order = sort === "latest"
      ? "d.created_at DESC"
      : sort === "hot"
        ? `(d.views+d.downloads*2+
            (SELECT COUNT(*)*3 FROM likes l WHERE l.document_id=d.id)) DESC`
        : "d.updated_at DESC";
    const rows = (await getDb()
      .prepare(
        `${documentSelect} ${join}
         WHERE ${clauses.join(" AND ")} ORDER BY ${order} LIMIT ${limit}`,
      )
      .all(user.id, user.id, ...parameters)) as SqlRow[];
    response.json(rows.map(documentJson));
  });

  router.post("/", upload.single("file"), async (request: AuthRequest, response) => {
    if (!request.file) throw new ApiError(400, "请选择上传文件");
    const user = userOf(request);
    const originalName = path.basename(
      normalizeUploadFilename(request.file.originalname),
    );
    const { storedPath, filePath, extension } = await persistUpload(
      request.file,
      originalName,
    );
    try {
      const extracted = await extractUploadedDocument(filePath, extension);
      const content = extracted.text.trim();
      const title =
        optionalText(request.body?.title, 150) || path.basename(originalName, extension);
      const category = optionalText(request.body?.category, 50) || "未分类";
      const tags = parseTags(request.body?.tags);
      const knowledgeBaseId = request.body?.knowledge_base_id
        ? numberId(request.body.knowledge_base_id)
        : undefined;
      if (knowledgeBaseId) await canAccessKnowledgeBase(knowledgeBaseId, user, true);
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
          .run(documentId, originalName, storedPath, request.file!.size, timestamp);
        // A newly inserted document cannot have old chunks. Skipping the
        // range DELETE avoids unnecessary InnoDB next-key locks that can
        // deadlock otherwise independent concurrent uploads.
        const chunkCount = await replaceChunks(documentId, extracted, false);
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
      response.status(201).json({
        ...documentJson(row),
        chunk_count: created.chunkCount,
        embedded_chunk_count: 0,
        embedding_queued: queueDocumentEmbedding(created.documentId),
      });
    } catch (error) {
      await fsp.rm(filePath, { force: true });
      throw error;
    }
  });

  router.get("/:id", async (request: AuthRequest, response) => {
    const id = numberId(request.params.id);
    const user = userOf(request);
    await canAccessDocument(id, user);
    await getDb().prepare("UPDATE documents SET views=views+1 WHERE id=?").run(id);
    const row = (await getDb()
      .prepare(`${documentSelect} WHERE d.id=?`)
      .get(user.id, user.id, id)) as SqlRow;
    const knowledgeBases = await getDb()
      .prepare(
        `SELECT k.id,k.name FROM knowledge_bases k
         JOIN kb_documents kd ON kd.knowledge_base_id=k.id
         WHERE kd.document_id=?
         ${["department_admin", "system_admin"].includes(user.role)
           ? ""
           : "AND (k.owner_id=? OR k.visibility IN ('shared','public'))"}
         ORDER BY k.name`,
      )
      .all(
        id,
        ...(["department_admin", "system_admin"].includes(user.role)
          ? []
          : [user.id]),
      );
    const versions = await getDb()
      .prepare(
        `SELECT id,version,filename,file_size,created_at
         FROM document_versions WHERE document_id=? ORDER BY version DESC`,
      )
      .all(id);
    response.json({
      ...documentJson(row),
      content: String(row.text_content ?? ""),
      knowledge_bases: knowledgeBases,
      versions,
    });
  });

  router.put("/:id", async (request: AuthRequest, response) => {
    const id = numberId(request.params.id);
    const user = userOf(request);
    await canAccessDocument(id, user, true);
    const title = optionalText(request.body?.title, 150);
    if (!title) throw new ApiError(400, "文档标题不能为空");
    const category = optionalText(request.body?.category, 50) || "未分类";
    const tags = parseTags(request.body?.tags);
    await transaction(async () => {
      await getDb()
        .prepare(
          `UPDATE documents SET title=?,category=?,tags=?,updated_at=? WHERE id=?`,
        )
        .run(title, category, JSON.stringify(tags), nowIso(), id);
      await syncRagSearchDocument(id);
    });
    const row = (await getDb()
      .prepare(`${documentSelect} WHERE d.id=?`)
      .get(user.id, user.id, id)) as SqlRow;
    response.json({ ...documentJson(row), content: String(row.text_content ?? "") });
  });

  router.post(
    "/:id/versions",
    upload.single("file"),
    async (request: AuthRequest, response) => {
      if (!request.file) throw new ApiError(400, "请选择版本文件");
      const id = numberId(request.params.id);
      const current = await canAccessDocument(id, userOf(request), true);
      const originalName = path.basename(
        normalizeUploadFilename(request.file.originalname),
      );
      const { storedPath, filePath, extension } = await persistUpload(
        request.file,
        originalName,
      );
      try {
        const extracted = await extractUploadedDocument(filePath, extension);
        const content = extracted.text.trim();
        const nextVersion = Number(current.version) + 1;
        const chunkCount = await transaction(async () => {
          const count = await replaceChunks(id, extracted, true, nextVersion);
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
            .run(id, nextVersion, originalName, storedPath, request.file!.size, timestamp);
          await syncRagSearchDocument(id);
          return count;
        });
        response.status(201).json({
          ok: true,
          version: nextVersion,
          chunk_count: chunkCount,
          embedded_chunk_count: 0,
          embedding_queued: queueDocumentEmbedding(id),
        });
      } catch (error) {
        await fsp.rm(filePath, { force: true });
        throw error;
      }
    },
  );

  router.delete("/:id", async (request: AuthRequest, response) => {
    const id = numberId(request.params.id);
    await canAccessDocument(id, userOf(request), true);
    const paths = (
      await getDb()
        .prepare("SELECT stored_path FROM document_versions WHERE document_id=?")
        .all(id)
    ).map((row) => resolveStoredPath(String(row.stored_path)));
    await getDb().prepare("DELETE FROM documents WHERE id=?").run(id);
    await Promise.all([...new Set(paths)].map((file) => fsp.rm(file, { force: true })));
    response.status(204).end();
  });

  router.get("/:id/preview", async (request: AuthRequest, response) => {
    const id = numberId(request.params.id);
    const row = await canAccessDocument(id, userOf(request));
    await getDb().prepare("UPDATE documents SET views=views+1 WHERE id=?").run(id);
    response.type(String(row.file_type).toLowerCase());
    response.setHeader(
      "Content-Disposition",
      `inline; filename*=UTF-8''${encodeURIComponent(String(row.filename))}`,
    );
    response.sendFile(resolveStoredPath(String(row.stored_path)));
  });

  router.get("/:id/download", async (request: AuthRequest, response) => {
    const id = numberId(request.params.id);
    const row = await canAccessDocument(id, userOf(request));
    await getDb().prepare("UPDATE documents SET downloads=downloads+1 WHERE id=?").run(id);
    response.download(
      resolveStoredPath(String(row.stored_path)),
      String(row.filename),
    );
  });

  router.get(
    "/:id/versions/:versionId/download",
    async (request: AuthRequest, response) => {
      const id = numberId(request.params.id);
      await canAccessDocument(id, userOf(request));
      const row = (await getDb()
        .prepare("SELECT * FROM document_versions WHERE id=? AND document_id=?")
        .get(numberId(request.params.versionId), id)) as SqlRow | undefined;
      if (!row) throw new ApiError(404, "历史版本不存在");
      response.download(
        resolveStoredPath(String(row.stored_path)),
        String(row.filename),
      );
    },
  );

  return router;
}
