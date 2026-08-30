import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { hashPassword } from "./auth.js";
import {
  allowedExtensions,
  defaultAdminPassword,
  storedPathFromAbsolute,
  uploadDirectory,
} from "./config.js";
import { ApiError, tagsFromJson } from "./core.js";
import { getDb, nowIso } from "./db.js";
import {
  chunkText,
  qualityScore,
  structuredChunks,
  type ExtractedDocument,
  type StructuredChunk,
} from "./documents.js";
import {
  cosineSimilarity,
  embedTexts,
  embeddingGeneration,
  embeddingMinimumScore,
  embeddingModelEnabled,
  embeddingModelName,
  embeddingProviderName,
} from "./embeddings.js";
import { dedupeTopK, weightedRrf, type RankedChannel } from "./rag-pipeline.js";
import { queryTerms } from "./search.js";
import type {
  AuthRequest,
  SearchResult,
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
  source: string | ExtractedDocument,
  replaceExisting = true,
  documentVersion?: number,
): Promise<number> {
  let chunks: StructuredChunk[] = typeof source === "string"
    ? chunkText(source).map((content) => ({
        content,
        pageStart: null,
        pageEnd: null,
        chapter: null,
        section: null,
        contentType: "content" as const,
        qualityScore: 1,
    }))
    : structuredChunks(source);
  if (!chunks.length && typeof source !== "string") {
    const audit = source.audit;
    const rejectedByCleaning = Boolean(
      audit && (
        audit.advertisementLines > 0 ||
        audit.repeatedMarginLines > 0 ||
        audit.pageNumberLines > 0 ||
        audit.replacementCharacters > 0 ||
        audit.privateUseCharacters > 0
      ),
    ) || qualityScore(source.text) < 0.48;
    if (rejectedByCleaning) {
      throw new ApiError(
        422,
        "文档内容全部被判定为广告、乱码或低质量文本，已拒绝建立索引",
      );
    }
    chunks = chunkText(source.text).map((content) => ({
      content,
      pageStart: null,
      pageEnd: null,
      chapter: null,
      section: null,
      contentType: "content" as const,
      qualityScore: 1,
    }));
  }
  if (!chunks.length) {
    throw new ApiError(
      400,
      "文档中没有识别到可索引文字；请确认 PDF 清晰且没有损坏或加密",
    );
  }
  const db = getDb();
  const document = await db.prepare(
    "SELECT version FROM documents WHERE id=?",
  ).get(documentId);
  const effectiveVersion = documentVersion ?? Number(document?.version ?? 1);
  if (replaceExisting) {
    await db
      .prepare("DELETE FROM document_chunks WHERE document_id=?")
      .run(documentId);
  }
  const insert = db.prepare(
    `INSERT INTO document_chunks(
      document_id,document_version,chunk_index,content,page_start,page_end,chapter,section,
      content_type,quality_score
     ) VALUES (?,?,?,?,?,?,?,?,?,?)`,
  );
  for (const [index, chunk] of chunks.entries()) {
    await insert.run(
      documentId,
      effectiveVersion,
      index,
      chunk.content,
      chunk.pageStart,
      chunk.pageEnd,
      chunk.chapter,
      chunk.section,
      chunk.contentType,
      chunk.qualityScore,
    );
  }
  await db.prepare(
    `INSERT INTO rag_chunk_search(
       chunk_id,document_id,document_version,content,title,filename,tags,chapter,section
     ) SELECT c.id,c.document_id,c.document_version,c.content,d.title,d.filename,d.tags,c.chapter,c.section
         FROM document_chunks c JOIN documents d ON d.id=c.document_id
        WHERE c.document_id=? AND c.document_version=?
     ON DUPLICATE KEY UPDATE
       document_id=VALUES(document_id),document_version=VALUES(document_version),
       content=VALUES(content),title=VALUES(title),filename=VALUES(filename),tags=VALUES(tags),
       chapter=VALUES(chapter),section=VALUES(section)`,
  ).run(documentId, effectiveVersion);
  return chunks.length;
}

export async function syncRagSearchDocument(documentId: number): Promise<number> {
  const result = await getDb().prepare(
    `INSERT INTO rag_chunk_search(
       chunk_id,document_id,document_version,content,title,filename,tags,chapter,section
     ) SELECT c.id,c.document_id,c.document_version,c.content,d.title,d.filename,d.tags,c.chapter,c.section
         FROM document_chunks c JOIN documents d ON d.id=c.document_id
        WHERE c.document_id=? AND c.document_version=d.version
     ON DUPLICATE KEY UPDATE
       document_id=VALUES(document_id),document_version=VALUES(document_version),
       content=VALUES(content),title=VALUES(title),filename=VALUES(filename),tags=VALUES(tags),
       chapter=VALUES(chapter),section=VALUES(section)`,
  ).run(documentId);
  return result.changes;
}

export async function persistUpload(
  file: Express.Multer.File,
  originalName = file.originalname,
): Promise<{ storedPath: string; filePath: string; extension: string }> {
  const extension = path.extname(originalName).toLowerCase();
  if (!allowedExtensions.has(extension)) {
    throw new ApiError(415, "仅支持 PDF、DOCX、TXT、Markdown 文件");
  }
  const mime = file.mimetype.trim().toLowerCase();
  const mimeByExtension: Record<string, Set<string>> = {
    ".pdf": new Set(["application/pdf", "application/octet-stream"]),
    ".docx": new Set([
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/octet-stream",
    ]),
    ".txt": new Set(["text/plain", "application/octet-stream"]),
    ".md": new Set(["text/markdown", "text/plain", "application/octet-stream"]),
  };
  if (!mimeByExtension[extension]?.has(mime)) {
    throw new ApiError(415, "文件扩展名与 MIME 类型不匹配");
  }
  const bytes = file.buffer;
  const hasPdfSignature = bytes.subarray(0, 5).toString("ascii") === "%PDF-";
  const hasZipSignature = bytes[0] === 0x50 && bytes[1] === 0x4b && [0x03, 0x05, 0x07]
    .includes(bytes[2] ?? -1);
  const hasExecutableSignature = bytes[0] === 0x4d && bytes[1] === 0x5a;
  const containsNul = bytes.subarray(0, Math.min(bytes.length, 8_192)).includes(0);
  if (
    (extension === ".pdf" && !hasPdfSignature) ||
    (extension === ".docx" && !hasZipSignature) ||
    ((extension === ".txt" || extension === ".md") && (hasExecutableSignature || containsNul))
  ) {
    throw new ApiError(415, "文件内容签名与扩展名不匹配");
  }
  const filePath = path.join(
    uploadDirectory,
    `${crypto.randomUUID().replaceAll("-", "")}${extension}`,
  );
  await fsp.writeFile(filePath, file.buffer);
  return {
    storedPath: storedPathFromAbsolute(filePath),
    filePath,
    extension,
  };
}

export async function searchChunks(
  user: User,
  query: string,
  options: {
    knowledgeBaseId?: number;
    documentIds?: number[];
    chapter?: string;
    category?: string;
    tag?: string;
    limit?: number;
  } = {},
): Promise<SearchResult> {
  const access = accessibleDocumentWhere(user);
  const clauses = [
    access.sql,
    "d.status='ready'",
    "c.document_version=d.version",
    "s.document_version=d.version",
  ];
  const parameters: Array<string | number> = [...access.params];
  let join = "";
  if (options.knowledgeBaseId) {
    await canAccessKnowledgeBase(options.knowledgeBaseId, user);
    join = "JOIN kb_documents kd ON kd.document_id=d.id";
    clauses.push("kd.knowledge_base_id=?");
    parameters.push(options.knowledgeBaseId);
  }
  if (options.documentIds?.length) {
    const documentIds = [...new Set(options.documentIds)].filter(
      (id) => Number.isInteger(id) && id > 0,
    );
    if (documentIds.length) {
      clauses.push(`d.id IN (${documentIds.map(() => "?").join(",")})`);
      parameters.push(...documentIds);
    }
  }
  if (options.chapter) {
    clauses.push("c.chapter=?");
    parameters.push(options.chapter);
  }
  if (options.category) {
    clauses.push("d.category=?");
    parameters.push(options.category);
  }
  if (options.tag) {
    clauses.push("d.tags LIKE ?");
    parameters.push(`%"${options.tag}"%`);
  }
  const limit = options.limit ?? 12;
  const candidateLimit = Math.max(60, Math.min(500, limit * 8));
  const select = `SELECT c.id AS chunk_id,c.chunk_index,c.document_version,c.content,
      c.page_start,c.page_end,c.chapter,c.section,c.content_type,c.quality_score,
      d.id AS document_id,d.title,d.filename,d.category,d.tags,d.updated_at`;
  const from = `FROM rag_chunk_search s
      JOIN document_chunks c ON c.id=s.chunk_id
      JOIN documents d ON d.id=c.document_id ${join}`;
  const toHit = (row: SqlRow): SearchHit => ({
      chunk_id: Number(row.chunk_id),
      chunk_index: Number(row.chunk_index),
      document_version: Number(row.document_version),
      document_id: Number(row.document_id),
      title: String(row.title),
      filename: String(row.filename),
      category: String(row.category),
      tags: tagsFromJson(row.tags),
      content: String(row.content),
      page_start: row.page_start === null ? null : Number(row.page_start),
      page_end: row.page_end === null ? null : Number(row.page_end),
      chapter: row.chapter ? String(row.chapter) : null,
      section: row.section ? String(row.section) : null,
      content_type: String(row.content_type ?? "content") as SearchHit["content_type"],
      quality_score: Number(row.quality_score ?? 1),
      score: Number(row.channel_score ?? 0),
      lexical_score: row.channel_score === undefined ? undefined : Number(row.channel_score),
    });
  const contentRows = await getDb().prepare(
    `${select},MATCH(s.content,s.chapter,s.section)
       AGAINST (? IN NATURAL LANGUAGE MODE) AS channel_score
     ${from}
     WHERE MATCH(s.content,s.chapter,s.section) AGAINST (? IN NATURAL LANGUAGE MODE)>0
       AND ${clauses.join(" AND ")}
     ORDER BY channel_score DESC,c.id ASC LIMIT ${candidateLimit}`,
  ).all(query, query, ...parameters);
  const metadataRows = await getDb().prepare(
    `${select},MATCH(s.title,s.filename,s.tags)
       AGAINST (? IN NATURAL LANGUAGE MODE) AS channel_score
     ${from}
     WHERE MATCH(s.title,s.filename,s.tags) AGAINST (? IN NATURAL LANGUAGE MODE)>0
       AND ${clauses.join(" AND ")}
     ORDER BY channel_score DESC,c.id ASC LIMIT ${candidateLimit}`,
  ).all(query, query, ...parameters);
  const exactTerms = queryTerms(query)
    .filter((term) => term.length >= 2 && term.length <= 80)
    .slice(0, 8);
  let exactRows: SqlRow[] = [];
  if (exactTerms.length) {
    const exactClauses = exactTerms.map((term) => term.length >= 4
      ? "(s.content LIKE ? OR s.title LIKE ? OR s.filename LIKE ? OR s.tags LIKE ?)"
      : "(s.title LIKE ? OR s.filename LIKE ? OR s.tags LIKE ?)");
    const exactParameters = exactTerms.flatMap((term) => term.length >= 4
      ? [`%${term}%`, `%${term}%`, `%${term}%`, `%${term}%`]
      : [`%${term}%`, `%${term}%`, `%${term}%`]);
    exactRows = await getDb().prepare(
      `${select},1 AS channel_score ${from}
       WHERE (${exactClauses.join(" OR ")}) AND ${clauses.join(" AND ")}
       ORDER BY c.id ASC LIMIT ${candidateLimit}`,
    ).all(...exactParameters, ...parameters);
  }
  const contentHits = contentRows.map(toHit);
  const metadataHits = metadataRows.map(toHit);
  const exactHits = exactRows.map(toHit);
  let vectorHits: SearchHit[] = [];
  try {
    if (embeddingModelEnabled()) {
      const queryVector = (await embedTexts([query]))[0];
      if (queryVector) {
        const semanticRows = await getDb().prepare(
          `${select},e.embedding ${from}
           JOIN chunk_embeddings e ON e.chunk_id=c.id
             AND e.generation=? AND e.provider=? AND e.model=?
             AND e.stale=0 AND e.document_version=d.version
           WHERE ${clauses.join(" AND ")}
           ORDER BY c.id ASC`,
        ).all(
          embeddingGeneration(), embeddingProviderName(), embeddingModelName(), ...parameters,
        );
        vectorHits = semanticRows.map((row): SearchHit | undefined => {
        let vector: unknown;
        try {
          vector = JSON.parse(String(row.embedding));
        } catch {
          return undefined;
        }
        if (
          !Array.isArray(vector) ||
          !vector.every(
            (value) => typeof value === "number" && Number.isFinite(value),
          )
        ) {
          return undefined;
        }
        const semanticScore = cosineSimilarity(queryVector, vector);
        if (semanticScore < embeddingMinimumScore()) return undefined;
        return {
          ...toHit(row),
          semantic_score: Number(semanticScore.toFixed(4)),
          embedding_generation: embeddingGeneration(),
          score: Number(semanticScore.toFixed(4)),
        };
        }).filter((row): row is SearchHit => Boolean(row))
          .sort((left, right) => (right.semantic_score ?? -1) - (left.semantic_score ?? -1))
          .slice(0, candidateLimit);
      }
    }
  } catch (error) {
    console.warn(
      "Embedding search failed; using lexical fallback:",
      error instanceof Error ? error.message : error,
    );
  }
  const channels: RankedChannel[] = [
    { name: "content", weight: Number(process.env.RAG_RRF_CONTENT_WEIGHT ?? 1), hits: contentHits },
    { name: "metadata", weight: Number(process.env.RAG_RRF_METADATA_WEIGHT ?? 1.25), hits: metadataHits },
    { name: "exact", weight: Number(process.env.RAG_RRF_EXACT_WEIGHT ?? 1.25), hits: exactHits },
  ];
  if (vectorHits.length) channels.push({
    name: "vector", weight: Number(process.env.RAG_RRF_VECTOR_WEIGHT ?? 1), hits: vectorHits,
  });
  const fused = weightedRrf(channels, Number(process.env.RAG_RRF_K ?? 60));
  return {
    engine: vectorHits.length ? "hybrid-vector-lexical" : "lexical",
    hits: dedupeTopK(fused, limit),
  };
}
