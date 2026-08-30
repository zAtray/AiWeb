import { createApp } from "./app.js";
import {
  assertAcceptanceDatabaseSafety,
  host,
  port,
  uploadRequestTimeoutMs,
} from "./config.js";
import {
  embeddingModelEnabled,
} from "./embeddings.js";
import { queueMissingEmbeddings } from "./embedding-queue.js";

// This must run before createApp(), because createApp() initializes the schema
// and may seed the administrator account.
assertAcceptanceDatabaseSafety();
const app = await createApp();
const server = app.listen(port, host, () => {
  console.log(`智知平台已启动：http://127.0.0.1:${port}`);
  if (embeddingModelEnabled()) {
    queueMissingEmbeddings();
  }
});

// Tailscale relay links can be slower than a LAN. Keep enough time for the
// request body to arrive; document embeddings are queued after the response.
server.requestTimeout = uploadRequestTimeoutMs;
