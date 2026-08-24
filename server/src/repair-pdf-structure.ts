import { closeDb, getDb, initDb, transaction } from "./db.js";

function requestedIds(): number[] {
  return [...new Set(process.argv.slice(2).map(Number).filter((id) => Number.isInteger(id) && id > 0))];
}

const expectedChapterCounts: Record<string, number> = {
  "2027计算机网络": 6,
  "2027计算机组成原理": 7,
  "2027数据结构": 8,
  "王道2027操作系统": 5,
};

function chapterFromContent(content: string): number | undefined {
  const prefix = content.slice(0, 180);
  const explicit = prefix.match(/(?:^|\n)\s*第\s*(\d{1,2})\s*章/u)?.[1];
  return explicit ? Number(explicit) : undefined;
}

function acceptableChapter(candidate: number | undefined, current: number, maximum: number): boolean {
  if (!candidate || candidate < 1 || candidate > maximum) return false;
  return current === 0 ? candidate === 1 : candidate === current || candidate === current + 1;
}

async function main(): Promise<void> {
  await initDb();
  const ids = requestedIds();
  if (!ids.length) throw new Error("请提供要修复的文档 ID");
  for (const documentId of ids) {
    const document = await getDb().prepare("SELECT title FROM documents WHERE id=?").get(documentId);
    const maximumChapter = expectedChapterCounts[String(document?.title ?? "")];
    if (!maximumChapter) throw new Error(`文档 ${documentId} 不是受支持的正式教材`);
    const chunks = await getDb().prepare(
      `SELECT id,content,chapter,section,content_type
       FROM document_chunks WHERE document_id=? ORDER BY chunk_index`,
    ).all(documentId);
    let currentChapter = 0;
    let changed = 0;
    await transaction(async () => {
      for (const chunk of chunks) {
        const contentType = String(chunk.content_type);
        let nextChapter: string | null;
        let nextSection = chunk.section ? String(chunk.section) : null;
        if (contentType === "toc") {
          nextChapter = null;
          nextSection = null;
        } else {
          const sectionChapter = Number(nextSection?.match(/^(\d{1,2})\./u)?.[1] ?? 0) || undefined;
          const explicitChapter = chapterFromContent(String(chunk.content));
          const detected = acceptableChapter(explicitChapter, currentChapter, maximumChapter)
            ? explicitChapter
            : acceptableChapter(sectionChapter, currentChapter, maximumChapter)
              ? sectionChapter
              : undefined;
          if (detected) currentChapter = detected;
          if (sectionChapter && !acceptableChapter(sectionChapter, currentChapter, maximumChapter)) {
            nextSection = null;
          }
          nextChapter = currentChapter ? `第${currentChapter}章` : null;
        }
        const existingChapter = chunk.chapter ? String(chunk.chapter) : null;
        const existingSection = chunk.section ? String(chunk.section) : null;
        if (existingChapter !== nextChapter || existingSection !== nextSection) {
          await getDb().prepare(
            "UPDATE document_chunks SET chapter=?,section=? WHERE id=?",
          ).run(nextChapter, nextSection, Number(chunk.id));
          changed += 1;
        }
      }
    });
    console.log(JSON.stringify({ documentId, chunks: chunks.length, changed }));
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
