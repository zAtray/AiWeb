import { closeDb, getDb, initDb, transaction } from "./db.js";
import { isPdfNoiseLine } from "./documents.js";
import { indexDocumentEmbeddings } from "./embeddings.js";

function documentIds(): number[] {
  return [...new Set(process.argv.slice(2).map(Number).filter((id) => Number.isInteger(id) && id > 0))];
}

async function main(): Promise<void> {
  await initDb();
  const ids = documentIds();
  if (!ids.length) throw new Error("请提供要修复的文档 ID");
  for (const documentId of ids) {
    const chunks = await getDb().prepare(
      "SELECT id,content FROM document_chunks WHERE document_id=? ORDER BY chunk_index",
    ).all(documentId);
    let changed = 0;
    await transaction(async () => {
      for (const chunk of chunks) {
        const cleaned = String(chunk.content)
          .split(/\r?\n/u)
          .filter((line) => !isPdfNoiseLine(line))
          .join("\n")
          .trim();
        if (cleaned && cleaned !== String(chunk.content)) {
          await getDb().prepare("UPDATE document_chunks SET content=? WHERE id=?")
            .run(cleaned, Number(chunk.id));
          chunk.content = cleaned;
          changed += 1;
        }
      }
      const cleanedText = chunks.map((chunk) => String(chunk.content)).join("\n\n");
      await getDb().prepare("UPDATE documents SET text_content=? WHERE id=?")
        .run(cleanedText, documentId);
    });
    const embeddings = changed ? await indexDocumentEmbeddings(documentId) : chunks.length;
    console.log(JSON.stringify({ documentId, chunks: chunks.length, changed, embeddings }));
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
