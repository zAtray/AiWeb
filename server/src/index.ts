import { createApp } from "./app.js";
import { port } from "./config.js";

const app = createApp();

app.listen(port, "0.0.0.0", () => {
  console.log(`智知平台已启动：http://127.0.0.1:${port}`);
});

