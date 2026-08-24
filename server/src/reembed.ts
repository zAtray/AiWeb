import { closeDb, getDb, initDb } from "./db.js";
import {
  embeddingModelEnabled,
  embeddingModelName,
  indexDocumentEmbeddings,
} from "./embeddings.js";

function requestedDocumentIds(): number[] {
  const argument = process.argv.find((value) => value.startsWith("--ids="));
  if (!argument) return [];
  return [...new Set(
    argument.slice("--ids=".length).split(",").map(Number)
      .filter((id) => Number.isInteger(id) && id > 0),
  )];
}

const documentIds = requestedDocumentIds();
if (!documentIds.length) {
  throw new Error("必须使用 --ids=203,204 明确指定文档，脚本不会默认处理全部数据");
}
if (!embeddingModelEnabled()) {
  throw new Error("EMBEDDING_ENABLED 未启用，拒绝生成空索引");
}

await initDb();
try {
  for (const documentId of documentIds) {
    const document = await getDb()
      .prepare("SELECT id,title FROM documents WHERE id=?")
      .get(documentId);
    if (!document) throw new Error(`文档 ${documentId} 不存在`);
    const indexed = await indexDocumentEmbeddings(documentId);
    console.log(JSON.stringify({
      document_id: documentId,
      title: String(document.title),
      model: embeddingModelName(),
      embedded_chunks: indexed,
    }));
  }
} finally {
  await closeDb();
}
