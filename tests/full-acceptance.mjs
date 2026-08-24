import fs from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";

try { process.loadEnvFile(); } catch {}
const baseUrl = process.env.TEST_BASE_URL ?? "http://127.0.0.1:18080";
const outputFile = process.env.TEST_REPORT_FILE ?? path.resolve("tests-output/full-acceptance.json");
const runId = process.env.TEST_RUN_ID ?? `acceptance_${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}`;
const results = [];
const state = { tokens: {}, users: {}, knowledgeBases: {}, documents: {}, comments: {}, sessions: {} };

function assert(condition, message) { if (!condition) throw new Error(message); }
async function jsonOrText(response) { const text = await response.text(); try { return text ? JSON.parse(text) : null; } catch { return text; } }
async function call(route, { method = "GET", token, body, expected = 200, headers } = {}) {
  const requestHeaders = new Headers(headers);
  if (token) requestHeaders.set("Authorization", `Bearer ${token}`);
  let payload = body;
  if (body && !(body instanceof FormData) && typeof body !== "string") { requestHeaders.set("Content-Type", "application/json"); payload = JSON.stringify(body); }
  const started = performance.now();
  const response = await fetch(`${baseUrl}${route}`, { method, headers: requestHeaders, body: payload });
  const data = await jsonOrText(response);
  if (![expected].flat().includes(response.status)) throw new Error(`${method} ${route}: expected ${expected}, got ${response.status}: ${JSON.stringify(data).slice(0, 500)}`);
  return { response, data, duration_ms: performance.now() - started };
}
async function upload(filename, bytes, { token, fields = {}, route = "/api/documents", expected = 201, type = "application/octet-stream" } = {}) {
  const form = new FormData(); form.set("file", new Blob([bytes], { type }), filename);
  for (const [key, value] of Object.entries(fields)) form.set(key, String(value));
  return call(route, { method: "POST", token, body: form, expected });
}
async function step(name, work, severity = "P0") {
  const started = performance.now();
  try { const detail = await work(); results.push({ name, severity, status: "pass", duration_ms: +(performance.now() - started).toFixed(1), detail }); }
  catch (error) { results.push({ name, severity, status: "fail", duration_ms: +(performance.now() - started).toFixed(1), error: error instanceof Error ? error.message : String(error) }); }
}
async function docxBytes(text) {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.folder("_rels").file(".rels", '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.folder("word").file("document.xml", `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`);
  return zip.generateAsync({ type: "nodebuffer" });
}

await step("guard: isolated database and local model URL", async () => {
  const { data } = await call("/api/health");
  assert(String(data.database_name).startsWith("zhizhi_acceptance_"), `unsafe database ${data.database_name}`);
  assert(data.remote_model_configured === false, "remote model configured");
  assert(data.database_version === "8.4.11", `unexpected MySQL ${data.database_version}`);
  return data;
});
await step("system config upload boundaries", async () => {
  const { data } = await call("/api/config"); assert(data.upload.max_mb === 50, "max upload mismatch");
  assert([".pdf", ".docx", ".txt", ".md"].every((ext) => data.upload.allowed_extensions.includes(ext)), "extension contract mismatch"); return data;
});
await step("auth rejects unauthenticated and malformed requests", async () => {
  await call("/api/stats", { expected: 401 });
  await call("/api/auth/register", { method: "POST", body: { username: "x", password: "123" }, expected: 400 });
  await call("/api/auth/login", { method: "POST", body: { account: "missing", password: "wrong-password" }, expected: 401 });
  await call("/api/auth/me", { headers: { Authorization: "Bearer invalid" }, expected: 401 });
});
await step("auth register and login by username email phone", async () => {
  for (const suffix of ["owner", "peer"]) {
    const username = `${runId}_${suffix}`.slice(0, 32); const email = `${username}@local.test`; const phone = `8${String(Date.now()).slice(-10)}${suffix === "owner" ? "1" : "2"}`;
    const { data } = await call("/api/auth/register", { method: "POST", body: { username, email, phone, password: "safe-pass-123" }, expected: 201 });
    state.tokens[suffix] = data.token; state.users[suffix] = data.user;
    for (const account of [username, email, phone]) await call("/api/auth/login", { method: "POST", body: { account, password: "safe-pass-123" } });
  }
  await call("/api/auth/register", { method: "POST", body: { username: state.users.owner.username, password: "safe-pass-123" }, expected: 409 });
  return state.users;
});
await step("knowledge base CRUD visibility duplicate and ownership", async () => {
  for (const visibility of ["private", "shared", "public"]) {
    const { data } = await call("/api/knowledge-bases", { method: "POST", token: state.tokens.owner, body: { name: `${runId}-${visibility}`, description: "edge acceptance", visibility }, expected: 201 }); state.knowledgeBases[visibility] = data;
  }
  await call("/api/knowledge-bases", { method: "POST", token: state.tokens.owner, body: { name: `${runId}-private`, visibility: "private" }, expected: 409 });
  await call("/api/knowledge-bases", { method: "POST", token: state.tokens.owner, body: { name: `${runId}-bad`, visibility: "world" }, expected: 400 });
  await call(`/api/knowledge-bases/${state.knowledgeBases.private.id}`, { method: "PUT", token: state.tokens.peer, body: { name: "stolen", visibility: "public" }, expected: 403 });
  const peerList = (await call("/api/knowledge-bases", { token: state.tokens.peer })).data;
  assert(!peerList.some((kb) => kb.id === state.knowledgeBases.private.id), "private KB leaked");
  assert(peerList.some((kb) => kb.id === state.knowledgeBases.shared.id) && peerList.some((kb) => kb.id === state.knowledgeBases.public.id), "visible KB missing");
});
await step("TXT MD DOCX upload extract list detail and assignment", async () => {
  const uploads = [
    ["中文 路径..测试.txt", Buffer.from("第一章 本地平台\n\n智知平台支持本地文档上传、混合检索和可追溯引用。".repeat(30)), "text/plain"],
    ["readme.md", Buffer.from("# 边缘测试\n\nMarkdown 文档用于验证知识检索。".repeat(30)), "text/markdown"],
    ["office.docx", await docxBytes("DOCX 文档支持本地解析和知识库问答。".repeat(30)), "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  ];
  for (const [filename, bytes, type] of uploads) {
    const { data } = await upload(filename, bytes, { token: state.tokens.owner, type, fields: { category: "验收", tags: "本地，验收，本地", knowledge_base_id: state.knowledgeBases.private.id } });
    assert(data.chunk_count > 0, `${filename} produced no chunks`); state.documents[path.extname(filename).slice(1)] = data;
  }
  const list = (await call(`/api/documents?scope=mine&category=${encodeURIComponent("验收")}`, { token: state.tokens.owner })).data;
  assert(list.length >= 3, "document filters missing uploads");
  const detail = (await call(`/api/documents/${state.documents.txt.id}`, { token: state.tokens.owner })).data;
  assert(detail.content.includes("可追溯引用"), "document content missing");
  assert(detail.knowledge_bases.some((kb) => kb.id === state.knowledgeBases.private.id), "KB assignment missing");
});
await step("document edit version preview download recommendation", async () => {
  const id = state.documents.txt.id;
  await call(`/api/documents/${id}`, { method: "PUT", token: state.tokens.owner, body: { title: `${runId}-updated`, category: "更新", tags: ["v2", "测试"] } });
  const version = await upload("v2.txt", Buffer.from("第二版本内容用于验证历史文件与重新分块。".repeat(40)), { token: state.tokens.owner, type: "text/plain", route: `/api/documents/${id}/versions` });
  assert(version.data.version === 2 && version.data.chunk_count > 0, "version update failed");
  const preview = await fetch(`${baseUrl}/api/documents/${id}/preview`, { headers: { Authorization: `Bearer ${state.tokens.owner}` } }); assert(preview.ok && (await preview.arrayBuffer()).byteLength > 10, "empty preview");
  const download = await fetch(`${baseUrl}/api/documents/${id}/download`, { headers: { Authorization: `Bearer ${state.tokens.owner}` } }); assert(download.ok && (await download.arrayBuffer()).byteLength > 10, "empty download");
  await call(`/api/documents/${id}/recommendations`, { token: state.tokens.owner });
});
await step("document rollback for rejected and corrupt uploads", async () => {
  const before = (await call("/api/documents?scope=mine", { token: state.tokens.owner })).data.length;
  await upload("blocked.exe", Buffer.from("not allowed"), { token: state.tokens.owner, expected: 415 });
  await upload("corrupt.pdf", Buffer.from("not a pdf"), { token: state.tokens.owner, type: "application/pdf", expected: 422 });
  const after = (await call("/api/documents?scope=mine", { token: state.tokens.owner })).data.length;
  assert(after === before, `failed uploads leaked rows: ${before} -> ${after}`);
});
await step("empty document rejection", async () => {
  await upload("empty.txt", Buffer.alloc(0), { token: state.tokens.owner, type: "text/plain", expected: 400 });
});
await step("upload exact size and over-limit boundary", async () => {
  const exact = Buffer.alloc(50 * 1024 * 1024, 0x41); const over = Buffer.alloc(50 * 1024 * 1024 + 1, 0x41);
  await upload("exact.docx", exact, { token: state.tokens.owner, type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", expected: 500 });
  await upload("over.docx", over, { token: state.tokens.owner, type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", expected: 413 });
});
await step("interaction toggle comments and ownership", async () => {
  const id = state.documents.txt.id;
  const favorite1 = (await call(`/api/documents/${id}/favorite`, { method: "POST", token: state.tokens.owner })).data; const favorite2 = (await call(`/api/documents/${id}/favorite`, { method: "POST", token: state.tokens.owner })).data;
  assert(favorite1.active === true && favorite2.active === false, "favorite toggle failed");
  const like1 = (await call(`/api/documents/${id}/like`, { method: "POST", token: state.tokens.owner })).data; const like2 = (await call(`/api/documents/${id}/like`, { method: "POST", token: state.tokens.owner })).data;
  assert(like1.active === true && like2.active === false, "like toggle failed");
  const comment = (await call(`/api/documents/${id}/comments`, { method: "POST", token: state.tokens.owner, body: { content: "验收评论" }, expected: 201 })).data; state.comments.owner = comment;
  await call(`/api/comments/${comment.id}`, { method: "DELETE", token: state.tokens.peer, expected: 403 });
  await call(`/api/comments/${comment.id}`, { method: "DELETE", token: state.tokens.owner, expected: 204 });
});
await step("sharing review admin roles and cross-user access", async () => {
  const id = state.documents.txt.id;
  await call(`/api/documents/${id}`, { token: state.tokens.peer, expected: 403 });
  await call(`/api/documents/${id}/share`, { method: "POST", token: state.tokens.owner });
  const admin = (await call("/api/auth/login", { method: "POST", body: { account: "admin", password: process.env.ADMIN_PASSWORD } })).data; state.tokens.admin = admin.token; state.users.admin = admin.user;
  const pending = (await call("/api/admin/share-requests", { token: state.tokens.admin })).data; assert(pending.some((doc) => doc.id === id), "share request missing");
  await call(`/api/admin/documents/${id}/review`, { method: "POST", token: state.tokens.admin, body: { approved: true, note: "acceptance" } });
  await call(`/api/documents/${id}`, { token: state.tokens.peer });
  await call(`/api/admin/users/${state.users.peer.id}/role`, { method: "PATCH", token: state.tokens.admin, body: { role: "department_admin" } });
  await call(`/api/admin/users/${state.users.admin.id}/role`, { method: "PATCH", token: state.tokens.admin, body: { role: "user" }, expected: 400 });
});
await step("search lexical fallback filters and empty query", async () => {
  const found = (await call(`/api/search?q=${encodeURIComponent("第二版本内容")}`, { token: state.tokens.owner })).data;
  assert(found.results.some((item) => item.document_id === state.documents.txt.id), "lexical search missed document");
  await call("/api/search?q=", { token: state.tokens.owner, expected: 400 });
  const none = (await call(`/api/search?q=${runId}-不存在的词`, { token: state.tokens.owner })).data; assert(Array.isArray(none.results), "search result shape invalid");
});
await step("chat fallback citations sessions and isolation", async () => {
  const first = (await call("/api/chat/ask", { method: "POST", token: state.tokens.owner, body: { question: "智知平台支持哪些本地能力？", knowledge_base_id: state.knowledgeBases.private.id } })).data;
  assert(first.session_id && typeof first.answer === "string" && Array.isArray(first.citations), "chat shape invalid"); state.sessions.owner = first.session_id;
  const follow = (await call("/api/chat/ask", { method: "POST", token: state.tokens.owner, body: { question: "请精简为一句话并保留引用", session_id: first.session_id } })).data;
  assert(follow.session_id === first.session_id, "follow-up changed session");
  await call(`/api/chat/sessions/${first.session_id}`, { token: state.tokens.peer, expected: 404 });
  const detail = (await call(`/api/chat/sessions/${first.session_id}`, { token: state.tokens.owner })).data; assert(detail.messages.length === 4, "chat history count mismatch");
  await call(`/api/chat/sessions/${first.session_id}`, { method: "DELETE", token: state.tokens.owner, expected: 204 });
});
await step("dashboard stats and delete cascades", async () => {
  const stats = (await call("/api/stats", { token: state.tokens.owner })).data; assert(stats.documents >= 3 && stats.searches >= 2, "stats not updated");
  const doomed = state.documents.md; await call(`/api/documents/${doomed.id}`, { method: "DELETE", token: state.tokens.owner, expected: 204 }); await call(`/api/documents/${doomed.id}`, { token: state.tokens.owner, expected: 404 });
  await call(`/api/knowledge-bases/${state.knowledgeBases.public.id}`, { method: "DELETE", token: state.tokens.owner, expected: 204 });
});
await step("logout invalidates token", async () => { const token = state.tokens.peer; await call("/api/auth/logout", { method: "POST", token, expected: 204 }); await call("/api/auth/me", { token, expected: 401 }); });

const report = { run_id: runId, base_url: baseUrl, started_at: new Date().toISOString(), totals: { passed: results.filter((item) => item.status === "pass").length, failed: results.filter((item) => item.status === "fail").length }, state, results };
await fs.mkdir(path.dirname(outputFile), { recursive: true }); await fs.writeFile(outputFile, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report.totals));
if (report.totals.failed) process.exitCode = 1;
