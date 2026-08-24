import fs from "node:fs/promises";
import path from "node:path";

try { process.loadEnvFile(); } catch {}
const baseUrl = process.env.TEST_BASE_URL ?? "http://127.0.0.1:18080";
const outputFile = process.env.TEST_AI_REPORT_FILE ?? path.resolve("tests-output/ai-acceptance.json");
const runId = process.env.TEST_RUN_ID ?? `ai_${Date.now()}`;
const startedAt = new Date().toISOString();
const checks = [];
function assert(condition, message) { if (!condition) throw new Error(message); }
async function api(route, { method = "GET", token, body, expected = 200 } = {}) { const headers = {}; if (token) headers.Authorization = `Bearer ${token}`; if (body && !(body instanceof FormData)) headers["Content-Type"] = "application/json"; const response = await fetch(`${baseUrl}${route}`, { method, headers, body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined }); const text = await response.text(); let data; try { data = text ? JSON.parse(text) : null; } catch { data = text; } if (response.status !== expected) throw new Error(`${method} ${route}: ${response.status} ${text.slice(0, 300)}`); return data; }
async function check(name, work) { const started = performance.now(); try { const detail = await work(); checks.push({ name, status: "pass", duration_ms: +(performance.now() - started).toFixed(1), detail }); return detail; } catch (error) { checks.push({ name, status: "fail", duration_ms: +(performance.now() - started).toFixed(1), error: error instanceof Error ? error.message : String(error) }); return null; } }
function validateAnswer(result, citationsRequired) { assert(result && typeof result.answer === "string" && result.answer.trim(), "empty answer"); assert(Array.isArray(result.citations), "citations not an array"); const references = [...result.answer.matchAll(/\[(\d+)\]/g)].map((match) => Number(match[1])); assert(references.every((index) => index >= 1 && index <= result.citations.length), "invalid citation reference"); if (citationsRequired) { assert(result.citations.length > 0, "missing citations"); assert(references.length > 0, "answer has no inline reference"); } return { engine: result.engine, retrieval_engine: result.retrieval_engine, citations: result.citations.length, answer_preview: result.answer.slice(0, 180) }; }

const health = await check("AI guard and local model status", async () => { const value = await api("/api/health"); assert(String(value.database_name).startsWith("zhizhi_acceptance_"), `unsafe database ${value.database_name}`); assert(value.remote_model_configured === false, "remote model configured"); assert(value.local_model === "qwen3:8b" && value.embedding_model === "qwen3-embedding:0.6b", "model config mismatch"); return value; });
let token; let kb; let document; let firstSession;
await check("AI fixture account and knowledge base", async () => { const username = runId.slice(0, 32); const registration = await api("/api/auth/register", { method: "POST", body: { username, password: "safe-pass-123" }, expected: 201 }); token = registration.token; const status = await api("/api/model/status", { token }); assert(status.status === "connected" && status.answer_model.available && status.embedding_model.available, `model status ${status.status}`); kb = await api("/api/knowledge-bases", { method: "POST", token, body: { name: `${runId}-kb`, visibility: "private" }, expected: 201 }); return status; });
await check("embedding queue indexes uploaded fixture", async () => { const before = Number(health?.embedding_index?.indexed ?? 0); const content = ["第一章 系统架构\n智知平台完全运行在本机，Web 服务使用 127.0.0.1，数据库版本为 MySQL 8.4.11。", "第二章 文档上传\n平台支持 PDF、DOCX、TXT、Markdown 四类文档，单个文件最大为 50 MiB。", "第三章 检索问答\n系统结合关键词与向量进行混合检索，AI 回答必须提供可以回到原始片段的引用。", "第四章 权限安全\n平台包含普通用户、部门管理员和系统管理员三级角色，并执行文档所有权隔离。"].join("\n\n").repeat(18); const form = new FormData(); form.set("file", new Blob([content], { type: "text/plain" }), `${runId}.txt`); form.set("knowledge_base_id", String(kb.id)); form.set("category", "AI验收"); const response = await fetch(`${baseUrl}/api/documents`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: form }); const text = await response.text(); assert(response.status === 201, `upload ${response.status}: ${text}`); document = JSON.parse(text); const deadline = Date.now() + 120000; let indexed = before; while (Date.now() < deadline) { const current = await api("/api/health"); indexed = Number(current.embedding_index?.indexed ?? 0); if (indexed > before) break; await new Promise((resolve) => setTimeout(resolve, 1000)); } assert(indexed > before, `embedding did not advance from ${before}`); return { document_id: document.id, chunks: document.chunk_count, indexed_before: before, indexed_after: indexed }; });
const questions = [
  ["本平台在什么地址运行，数据库版本是什么？", true],
  ["平台支持哪四类文档，最大上传大小是多少？", true],
  ["平台如何进行检索，AI 回答有什么引用要求？", true],
  ["平台有哪些用户角色？", true],
  ["请概览这份资料的主要章节。", true],
  ["列出当前知识库中的文档。", false],
  ["文档所有权隔离的目的是什么？", true],
  ["本平台是否依赖远程云数据库？", true],
  ["第二章主要说明什么？", true],
  ["引用为什么能够回到原始片段？", true],
  ["资料中有没有说明火星天气？", false],
  ["请用两点总结检索与权限能力。", true],
];
for (let index = 0; index < questions.length; index += 2) { await Promise.all(questions.slice(index, index + 2).map(async ([question, citationsRequired], offset) => check(`AI question ${index + offset + 1}: ${question}`, async () => { const result = await api("/api/chat/ask", { method: "POST", token, body: { question, knowledge_base_id: kb.id } }); if (index + offset === 0) firstSession = result.session_id; return validateAnswer(result, citationsRequired); }))); }
await check("contextual follow-up preserves session and citations", async () => { const result = await api("/api/chat/ask", { method: "POST", token, body: { question: "把刚才的答案精简成一句话并保留引用。", session_id: firstSession } }); assert(result.session_id === firstSession, "session changed"); return validateAnswer(result, true); });
await check("AI session history and deletion", async () => { const detail = await api(`/api/chat/sessions/${firstSession}`, { token }); assert(detail.messages.length === 4, `unexpected messages ${detail.messages.length}`); await api(`/api/chat/sessions/${firstSession}`, { method: "DELETE", token, expected: 204 }); return { messages: detail.messages.length }; });
const report = { run_id: runId, started_at: startedAt, finished_at: new Date().toISOString(), totals: { passed: checks.filter((item) => item.status === "pass").length, failed: checks.filter((item) => item.status === "fail").length }, fixture: { knowledge_base_id: kb?.id, document_id: document?.id }, checks };
await fs.mkdir(path.dirname(outputFile), { recursive: true }); await fs.writeFile(outputFile, JSON.stringify(report, null, 2)); console.log(JSON.stringify(report.totals)); if (report.totals.failed) process.exitCode = 1;
