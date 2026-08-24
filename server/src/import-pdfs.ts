import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { projectRoot, uploadDirectory } from "./config.js";
import { closeDb, getDb, initDb, nowIso, transaction } from "./db.js";
import { extractDocument, type DocumentCleaningAudit } from "./documents.js";
import { indexDocumentEmbeddings } from "./embeddings.js";
import { ocrPdfPages } from "./ocr.js";
import { replaceChunks, seedAdmin } from "./services.js";
import type { SqlRow } from "./types.js";

const defaultSources = [
  "2027计算机网络_高清带书签版.pdf",
  "2027计算机组成原理_高清带书签版.pdf",
  "2027数据结构_高清带书签版.pdf",
  "王道2027操作系统-高清带书签.pdf",
].map((filename) => path.join(projectRoot, "data", "import-source", filename));

interface ImportResult {
  source: string;
  sha256: string;
  documentId: number;
  title: string;
  status: "imported" | "already_imported";
  pages: number;
  ocrPages: number;
  emptyPages: number;
  advertisementLines: number;
  repeatedMarginLines: number;
  pageNumberLines: number;
  replacementCharacters: number;
  privateUseCharacters: number;
  discardedLowQualityChunks: number;
  duplicateChunks: number;
  chapters: number;
  chunks: number;
  embeddings: number;
}

const reportPath = path.join(projectRoot, "runtime", "pdf-import-report.json");

function option(name: string, fallback: string): string {
  const prefix = `--${name}=`;
  return process.argv.slice(2).find((value) => value.startsWith(prefix))?.slice(prefix.length) || fallback;
}

function sources(): string[] {
  const values = process.argv.slice(2).filter((value) => !value.startsWith("--"));
  return values.length ? values.map((value) => path.resolve(value)) : defaultSources;
}

async function sha256(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

async function streamCopy(source: string, destination: string): Promise<void> {
  const temporary = `${destination}.partial`;
  await fs.rm(temporary, { force: true });
  try {
    await pipeline(createReadStream(source), createWriteStream(temporary, { flags: "wx" }));
    await fs.rename(temporary, destination);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

function displayTitle(filename: string): string {
  return path.basename(filename, path.extname(filename))
    .replace(/[-_]?高清带书签版?$/u, "")
    .trim();
}

async function exactExistingDocument(hash: string, size: number): Promise<SqlRow | undefined> {
  const candidates = await getDb()
    .prepare("SELECT id,title,stored_path,file_size FROM documents WHERE file_size=?")
    .all(size);
  for (const candidate of candidates) {
    const storedPath = String(candidate.stored_path ?? "");
    try {
      if (storedPath && await sha256(storedPath) === hash) return candidate;
    } catch {
      // A stale database row is not an idempotence match.
    }
  }
  return undefined;
}

async function ensureKnowledgeBase(ownerId: number, name: string): Promise<number> {
  const existing = await getDb()
    .prepare("SELECT id FROM knowledge_bases WHERE owner_id=? AND name=?")
    .get(ownerId, name);
  if (existing) return Number(existing.id);
  const timestamp = nowIso();
  const created = await getDb().prepare(
    `INSERT INTO knowledge_bases(owner_id,name,description,visibility,created_at,updated_at)
     VALUES (?,?,'2027 王道计算机考研四门教材 OCR 知识库','private',?,?)`,
  ).run(ownerId, name, timestamp, timestamp);
  return Number(created.lastInsertRowid);
}

async function linkKnowledgeBase(knowledgeBaseId: number, documentId: number): Promise<void> {
  await getDb().prepare(
    `INSERT IGNORE INTO kb_documents(knowledge_base_id,document_id,added_at)
     VALUES (?,?,?)`,
  ).run(knowledgeBaseId, documentId, nowIso());
}

function resultFromAudit(
  source: string,
  hash: string,
  documentId: number,
  title: string,
  status: ImportResult["status"],
  audit: Partial<DocumentCleaningAudit>,
  chunks: number,
  embeddings: number,
): ImportResult {
  return {
    source,
    sha256: hash,
    documentId,
    title,
    status,
    pages: audit.pageCount ?? 0,
    ocrPages: audit.ocrPages ?? 0,
    emptyPages: audit.emptyPages ?? 0,
    advertisementLines: audit.advertisementLines ?? 0,
    repeatedMarginLines: audit.repeatedMarginLines ?? 0,
    pageNumberLines: audit.pageNumberLines ?? 0,
    replacementCharacters: audit.replacementCharacters ?? 0,
    privateUseCharacters: audit.privateUseCharacters ?? 0,
    discardedLowQualityChunks: audit.discardedLowQualityChunks ?? 0,
    duplicateChunks: audit.duplicateChunks ?? 0,
    chapters: audit.chapterCount ?? 0,
    chunks,
    embeddings,
  };
}

async function databaseCounts(documentId: number): Promise<{ chunks: number; embeddings: number; chapters: number }> {
  const row = await getDb().prepare(
    `SELECT COUNT(*) AS chunks,
       COUNT(e.chunk_id) AS embeddings,
       COUNT(DISTINCT NULLIF(c.chapter,'')) AS chapters
     FROM document_chunks c
     LEFT JOIN chunk_embeddings e ON e.chunk_id=c.id
     WHERE c.document_id=?`,
  ).get(documentId);
  return {
    chunks: Number(row?.chunks ?? 0),
    embeddings: Number(row?.embeddings ?? 0),
    chapters: Number(row?.chapters ?? 0),
  };
}

async function importOne(
  source: string,
  ownerId: number,
  knowledgeBaseId: number,
): Promise<ImportResult> {
  const stat = await fs.stat(source);
  if (!stat.isFile() || path.extname(source).toLowerCase() !== ".pdf") {
    throw new Error(`不是可导入的 PDF 文件：${source}`);
  }
  const hash = await sha256(source);
  const title = displayTitle(source);
  const existing = await exactExistingDocument(hash, stat.size);
  if (existing) {
    const documentId = Number(existing.id);
    await linkKnowledgeBase(knowledgeBaseId, documentId);
    const counts = await databaseCounts(documentId);
    return resultFromAudit(
      source, hash, documentId, String(existing.title ?? title), "already_imported",
      { chapterCount: counts.chapters }, counts.chunks, counts.embeddings,
    );
  }

  const storedPath = path.join(uploadDirectory, `${hash}.pdf`);
  try {
    await fs.access(storedPath);
    if (await sha256(storedPath) !== hash) throw new Error(`目标文件哈希冲突：${storedPath}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await streamCopy(source, storedPath);
  }

  let documentId: number | undefined;
  try {
    let lastPercent = -1;
    const extracted = await extractDocument(storedPath, ".pdf", {
      ocrPdfPages: (filePath, pages) => ocrPdfPages(filePath, {
        pages,
        onProgress: (completed, total) => {
          const percent = Math.floor(completed * 100 / total);
          if (percent >= lastPercent + 5 || completed === total) {
            lastPercent = percent;
            console.log(`[OCR] ${title}: ${completed}/${total} (${percent}%)`);
          }
        },
      }),
    });
    if (!extracted.text.trim()) throw new Error(`${title} 未识别到任何文字`);
    const timestamp = nowIso();
    const created = await transaction(async () => {
      const inserted = await getDb().prepare(
        `INSERT INTO documents(
          owner_id,title,filename,stored_path,file_type,file_size,category,tags,
          text_content,status,share_status,created_at,updated_at
        ) VALUES (?,?,?,?,?,?,?,? ,?,'ready','private',?,?)`,
      ).run(
        ownerId, title, path.basename(source), storedPath, "PDF", stat.size,
        "2027考研教材", JSON.stringify(["王道", "2027", title]),
        extracted.text, timestamp, timestamp,
      );
      const id = Number(inserted.lastInsertRowid);
      await getDb().prepare(
        `INSERT INTO document_versions(document_id,version,filename,stored_path,file_size,created_at)
         VALUES (?,1,?,?,?,?)`,
      ).run(id, path.basename(source), storedPath, stat.size, timestamp);
      await linkKnowledgeBase(knowledgeBaseId, id);
      const chunks = await replaceChunks(id, extracted);
      const cleanedRows = await getDb().prepare(
        "SELECT content FROM document_chunks WHERE document_id=? ORDER BY chunk_index",
      ).all(id);
      const cleanedText = cleanedRows.map((row) => String(row.content)).join("\n\n");
      await getDb().prepare("UPDATE documents SET text_content=? WHERE id=?")
        .run(cleanedText, id);
      return { id, chunks };
    });
    documentId = created.id;
    const embeddings = await indexDocumentEmbeddings(documentId);
    const counts = await databaseCounts(documentId);
    if (counts.chunks !== created.chunks || counts.embeddings !== counts.chunks || embeddings !== counts.chunks) {
      throw new Error(
        `${title} 索引不完整：chunks=${counts.chunks}, embeddings=${counts.embeddings}, indexed=${embeddings}`,
      );
    }
    return resultFromAudit(
      source, hash, documentId, title, "imported", extracted.audit ?? {},
      counts.chunks, counts.embeddings,
    );
  } catch (error) {
    if (documentId) await getDb().prepare("DELETE FROM documents WHERE id=?").run(documentId);
    await fs.rm(storedPath, { force: true });
    throw error;
  }
}

async function saveReport(results: ImportResult[], failures: Array<{ source: string; error: string }>): Promise<void> {
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  let previous: { results?: ImportResult[]; failures?: Array<{ source: string; error: string }> } = {};
  try {
    previous = JSON.parse(await fs.readFile(reportPath, "utf8")) as typeof previous;
  } catch {
    // The first import creates the report.
  }
  const mergedResults = new Map<string, ImportResult>();
  for (const result of [...(previous.results ?? []), ...results]) {
    const prior = mergedResults.get(result.sha256);
    mergedResults.set(
      result.sha256,
      prior && result.status === "already_imported"
        ? { ...result, ...prior, status: "already_imported" }
        : result,
    );
  }
  const successfulSources = new Set([...mergedResults.values()].map((result) => result.source));
  const mergedFailures = [...(previous.failures ?? []), ...failures]
    .filter((failure) => !successfulSources.has(failure.source));
  await fs.writeFile(reportPath, `${JSON.stringify({
    generatedAt: nowIso(),
    results: [...mergedResults.values()],
    failures: mergedFailures,
  }, null, 2)}\n`, "utf8");
}

async function main(): Promise<void> {
  await initDb();
  await seedAdmin();
  const ownerName = option("owner", "admin");
  const knowledgeBaseName = option("knowledge-base", "2027王道考研教材");
  const owner = await getDb().prepare("SELECT id FROM users WHERE username=?").get(ownerName);
  if (!owner) throw new Error(`导入账号不存在：${ownerName}`);
  const ownerId = Number(owner.id);
  const knowledgeBaseId = await ensureKnowledgeBase(ownerId, knowledgeBaseName);
  const results: ImportResult[] = [];
  const failures: Array<{ source: string; error: string }> = [];
  for (const source of sources()) {
    console.log(`\n[IMPORT] ${source}`);
    try {
      const result = await importOne(source, ownerId, knowledgeBaseId);
      results.push(result);
      console.log(JSON.stringify(result, null, 2));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push({ source, error: message });
      console.error(`[FAILED] ${source}: ${message}`);
    }
    await saveReport(results, failures);
  }
  if (failures.length) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
