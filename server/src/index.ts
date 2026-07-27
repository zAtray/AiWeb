import { createApp } from "./app.js";
import { port } from "./config.js";
import {
  backfillMissingEmbeddings,
  embeddingModelEnabled,
} from "./embeddings.js";

const app = await createApp();

app.listen(port, "0.0.0.0", () => {
  console.log(`智知平台已启动：http://127.0.0.1:${port}`);
  if (embeddingModelEnabled()) {
    void backfillMissingEmbeddings()
      .then((count) => {
        console.log(`向量索引已同步：新增 ${count} 个文档片段`);
      })
      .catch((error: unknown) => {
        console.warn(
          "向量索引同步失败；全文检索仍可用：",
          error instanceof Error ? error.message : error,
        );
      });
  }
});
