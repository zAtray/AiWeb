import { closeDb, initDb } from "./db.js";
import {
  embeddingApiConfigured,
  embeddingModelName,
  embeddingSourceStats,
  rebuildAllEmbeddings,
} from "./embeddings.js";

if (!process.argv.includes("--confirm-write-stop")) {
  throw new Error("请先停止应用写入，再使用 --confirm-write-stop 执行全量向量重建");
}
if (!embeddingApiConfigured()) {
  throw new Error("缺少 EMBEDDING_API_BASE_URL/API_KEY/MODEL/DIMENSION，重建保持 BLOCKED");
}

await initDb();
try {
  const before = await embeddingSourceStats();
  console.log(JSON.stringify({ phase: "preflight", ...before, source_data_will_be_deleted: false }));
  const result = await rebuildAllEmbeddings();
  console.log(JSON.stringify({
    phase: "complete",
    model: embeddingModelName(),
    ...result,
    source_data_unchanged: result.documents === before.documents && result.chunks === before.chunks,
  }));
} finally {
  await closeDb();
}
