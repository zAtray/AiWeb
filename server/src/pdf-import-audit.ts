import fs from "node:fs/promises";
import path from "node:path";
import { projectRoot } from "./config.js";
import { closeDb, getDb, initDb, nowIso } from "./db.js";
import type { SqlRow } from "./types.js";

const textbookTitles = [
  "2027计算机网络",
  "2027计算机组成原理",
  "2027数据结构",
  "王道2027操作系统",
];
const expectedChapterCounts: Record<string, number> = {
  "2027计算机网络": 6,
  "2027计算机组成原理": 7,
  "2027数据结构": 8,
  "王道2027操作系统": 5,
};
const noisePattern = /(?:taobao|bilibili|QQ群|购买王道|下载网站|高清带书签|王道教育|\uFFFD|[\uE000-\uF8FF])/iu;

function evenlySpacedSamples(rows: SqlRow[], count: number): SqlRow[] {
  if (rows.length <= count) return rows;
  const indexes = new Set<number>();
  for (let index = 0; index < count; index += 1) {
    indexes.add(Math.round(index * (rows.length - 1) / (count - 1)));
  }
  return [...indexes].map((index) => rows[index]!).filter(Boolean);
}

async function main(): Promise<void> {
  await initDb();
  const placeholders = textbookTitles.map(() => "?").join(",");
  const documents = await getDb().prepare(
    `SELECT id,title,filename,file_size,owner_id,share_status,status
     FROM documents WHERE title IN (${placeholders}) ORDER BY id`,
  ).all(...textbookTitles);
  const knowledgeBase = await getDb().prepare(
    `SELECT k.id,k.name,k.visibility,u.username
     FROM knowledge_bases k JOIN users u ON u.id=k.owner_id
     WHERE k.name='2027王道考研教材'`,
  ).get();
  const linkedDocuments = knowledgeBase
    ? await getDb().prepare(
      `SELECT d.id,d.title FROM kb_documents kd
       JOIN documents d ON d.id=kd.document_id
       WHERE kd.knowledge_base_id=? ORDER BY d.id`,
    ).all(Number(knowledgeBase.id))
    : [];
  const preservedDocument = await getDb().prepare(
    "SELECT id,title,filename FROM documents WHERE title='123' ORDER BY id LIMIT 1",
  ).get();

  const violations: string[] = [];
  if (documents.length !== textbookTitles.length) {
    violations.push(`教材文档数量应为 4，实际为 ${documents.length}`);
  }
  if (!knowledgeBase || knowledgeBase.visibility !== "private" || knowledgeBase.username !== "admin") {
    violations.push("教材知识库必须存在且属于 admin、visibility=private");
  }
  const linkedTitles = new Set(linkedDocuments.map((row) => String(row.title)));
  if (linkedDocuments.length !== 4 || textbookTitles.some((title) => !linkedTitles.has(title))) {
    violations.push("教材知识库必须且只能关联四本正式教材");
  }
  if (!preservedDocument) violations.push("原有文档 123 未保留");

  const documentAudits = [];
  for (const document of documents) {
    const documentId = Number(document.id);
    const chunks = await getDb().prepare(
      `SELECT c.id,c.chunk_index,c.content,c.page_start,c.page_end,c.chapter,c.section,
         c.content_type,c.quality_score,CASE WHEN e.chunk_id IS NULL THEN 0 ELSE 1 END embedded
       FROM document_chunks c LEFT JOIN chunk_embeddings e ON e.chunk_id=c.id
       WHERE c.document_id=? ORDER BY c.chunk_index`,
    ).all(documentId);
    let previousPage = 0;
    let pageOrderViolations = 0;
    let noiseHits = 0;
    let missingEmbeddings = 0;
    const chapters = new Map<string, { firstPage: number; lastPage: number; chunks: number }>();
    for (const chunk of chunks) {
      const page = Number(chunk.page_start ?? 0);
      if (page && page < previousPage) pageOrderViolations += 1;
      if (page) previousPage = page;
      if (noisePattern.test(String(chunk.content))) noiseHits += 1;
      if (!Number(chunk.embedded)) missingEmbeddings += 1;
      const chapter = chunk.chapter ? String(chunk.chapter) : "";
      if (chapter) {
        const current = chapters.get(chapter) ?? {
          firstPage: page || Number.MAX_SAFE_INTEGER,
          lastPage: Number(chunk.page_end ?? page),
          chunks: 0,
        };
        current.firstPage = Math.min(current.firstPage, page || current.firstPage);
        current.lastPage = Math.max(current.lastPage, Number(chunk.page_end ?? page));
        current.chunks += 1;
        chapters.set(chapter, current);
      }
    }
    if (!chunks.length) violations.push(`${document.title} 没有 chunk`);
    if (missingEmbeddings) violations.push(`${document.title} 缺少 ${missingEmbeddings} 个 embedding`);
    if (pageOrderViolations) violations.push(`${document.title} 有 ${pageOrderViolations} 处页码逆序`);
    if (noiseHits) violations.push(`${document.title} 有 ${noiseHits} 个噪声 chunk`);
    const expectedChapters = expectedChapterCounts[String(document.title)];
    if (chapters.size !== expectedChapters) {
      violations.push(`${document.title} 应识别 ${expectedChapters} 章，实际为 ${chapters.size} 章`);
    }
    const samples = evenlySpacedSamples(chunks, 20).map((chunk) => ({
      chunkId: Number(chunk.id),
      chunkIndex: Number(chunk.chunk_index),
      page: Number(chunk.page_start),
      chapter: chunk.chapter ? String(chunk.chapter) : null,
      section: chunk.section ? String(chunk.section) : null,
      excerpt: String(chunk.content).replace(/\s+/gu, " ").slice(0, 220),
    }));
    if (samples.length < 20) violations.push(`${document.title} 抽样不足 20 个 chunk`);
    documentAudits.push({
      documentId,
      title: String(document.title),
      filename: String(document.filename),
      chunks: chunks.length,
      embeddings: chunks.length - missingEmbeddings,
      noiseHits,
      pageOrderViolations,
      chapters: [...chapters.entries()].map(([chapter, values]) => ({ chapter, ...values })),
      samples,
    });
  }

  const report = {
    generatedAt: nowIso(),
    passed: violations.length === 0,
    violations,
    knowledgeBase,
    linkedDocuments,
    preservedDocument,
    documents: documentAudits,
  };
  const reportPath = path.join(projectRoot, "runtime", "pdf-database-audit.json");
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({
    reportPath,
    passed: report.passed,
    violations,
    documents: documentAudits.map((document) => ({
      id: document.documentId,
      title: document.title,
      chapters: document.chapters.length,
      chunks: document.chunks,
      embeddings: document.embeddings,
      noiseHits: document.noiseHits,
      pageOrderViolations: document.pageOrderViolations,
      samples: document.samples.length,
    })),
  }, null, 2));
  if (violations.length) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
