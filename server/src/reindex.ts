import fs from "node:fs/promises";
import path from "node:path";
import { resolveStoredPath } from "./config.js";
import { closeDb, getDb, initDb, transaction } from "./db.js";
import { chunkText, extractDocument, structuredChunks } from "./documents.js";
import { embeddingModelEnabled, indexDocumentEmbeddings } from "./embeddings.js";
import { replaceChunks } from "./services.js";
import type { SqlRow } from "./types.js";

function requestedDocumentIds(): number[] {
  const argument = process.argv.find((value) => value.startsWith("--ids="));
  if (!argument) return [];
  return [
    ...new Set(
      argument
        .slice("--ids=".length)
        .split(",")
        .map(Number)
        .filter((id) => Number.isInteger(id) && id > 0),
    ),
  ];
}

const documentIds = requestedDocumentIds();
const dryRun = process.argv.includes("--dry-run");
const skipEmbeddings = process.argv.includes("--skip-embeddings");
const reparsePdf = process.argv.includes("--reparse-pdf");

if (!documentIds.length) {
  throw new Error("必须使用 --ids=203,204 明确指定要重建的文档，脚本不会默认处理全部数据");
}

await initDb();
try {
  for (const documentId of documentIds) {
    const document = (await getDb()
      .prepare(
        "SELECT id,title,stored_path,file_type,text_content FROM documents WHERE id=?",
      )
      .get(documentId)) as SqlRow | undefined;
    if (!document) throw new Error(`文档 ${documentId} 不存在`);
    const storedPath = resolveStoredPath(String(document.stored_path));
    await fs.access(storedPath);
    const extension = path.extname(storedPath).toLowerCase();
    if (extension !== ".pdf") {
      throw new Error(`文档 ${documentId} 不是 PDF，拒绝用 PDF 重建流程处理`);
    }
    const oldRow = await getDb()
      .prepare("SELECT COUNT(*) AS count FROM document_chunks WHERE document_id=?")
      .get(documentId);
    const storedText = String(document.text_content ?? "").trim();
    const extracted = reparsePdf
      ? await extractDocument(storedPath, extension)
      : {
          text: storedText,
          pages: storedText ? [{ page: null, text: storedText }] : [],
        };
    if (!extracted.text.trim()) {
      throw new Error(
        `文档 ${documentId} 没有已提取文字；请使用 --reparse-pdf 重新解析原文件`,
      );
    }
    const rawChunkCount = chunkText(extracted.text).length;
    const chunks = structuredChunks(extracted);
    const advertisementSource = "购买.{0,20}(?:书|图书|课程|淘宝|店)|taobao\\.com|兑换码|扫码添加|微信咨询|课程咨询|配套视频|盗版书|邮购电话|质量投诉|侵权举报|王道训练营";
    const rawAdvertisementMatches = extracted.text.match(
      new RegExp(advertisementSource, "giu"),
    )?.length ?? 0;
    const advertisementPattern = new RegExp(advertisementSource, "iu");
    const keptAdvertisementChunks = chunks.filter((chunk) =>
      advertisementPattern.test(chunk.content),
    ).length;
    const report = {
      document_id: documentId,
      title: String(document.title),
      pages: extracted.pages.filter((page) => page.page !== null).length,
      source: reparsePdf ? "pdf" : "stored_text_content",
      old_chunks: Number(oldRow?.count ?? 0),
      raw_chunks: rawChunkCount,
      kept_chunks: chunks.length,
      chunk_count_delta: chunks.length - rawChunkCount,
      raw_advertisement_matches: rawAdvertisementMatches,
      kept_advertisement_chunks: keptAdvertisementChunks,
      chapter_chunks: chunks.filter((chunk) => chunk.chapter).length,
      section_chunks: chunks.filter((chunk) => chunk.section).length,
      page_metadata_chunks: chunks.filter((chunk) => chunk.pageStart).length,
      toc_chunks: chunks.filter((chunk) => chunk.contentType === "toc").length,
      chapters: [...new Set(chunks.map((chunk) => chunk.chapter).filter(Boolean))],
    };
    console.log(JSON.stringify({ phase: "parsed", dry_run: dryRun, ...report }));
    if (dryRun) continue;
    await transaction(() => replaceChunks(documentId, extracted));
    let embedded = 0;
    if (!skipEmbeddings && embeddingModelEnabled()) {
      embedded = await indexDocumentEmbeddings(documentId);
    }
    console.log(
      JSON.stringify({ phase: "rebuilt", ...report, embedded_chunks: embedded }),
    );
  }
} finally {
  await closeDb();
}
