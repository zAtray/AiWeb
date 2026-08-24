import {
  embeddingModelEnabled,
  indexDocumentEmbeddings,
} from "./embeddings.js";

export function queueDocumentEmbedding(documentId: number): boolean {
  if (!embeddingModelEnabled()) return false;
  setImmediate(() => {
    void indexDocumentEmbeddings(documentId)
      .then((count) => {
        console.log(`文档 ${documentId} 向量索引已同步：${count} 个片段`);
      })
      .catch((error: unknown) => {
        console.warn(
          `文档 ${documentId} 向量索引失败；全文检索仍可用：`,
          error instanceof Error ? error.message : error,
        );
      });
  });
  return true;
}
