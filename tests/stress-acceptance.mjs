import fs from "node:fs/promises";
import path from "node:path";

const baseUrl = process.env.TEST_BASE_URL ?? "http://127.0.0.1:18080";
const outputFile = process.env.TEST_STRESS_REPORT_FILE ?? path.resolve("tests-output/stress.json");
const runId = process.env.TEST_RUN_ID ?? `stress_${Date.now()}`;
const health = await fetch(`${baseUrl}/api/health`).then((response) => response.json());
if (!String(health.database_name).startsWith("zhizhi_acceptance_")) throw new Error(`Refusing stress test against ${health.database_name}`);
const username = `stress_${Date.now()}_${runId.slice(-6)}`.slice(0, 32);
const registration = await fetch(`${baseUrl}/api/auth/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username, password: "safe-pass-123" }) });
if (registration.status !== 201) throw new Error(`Registration failed: ${registration.status} ${await registration.text()}`);
const { token } = await registration.json();
const latencies = []; let errors = 0; let next = 0; const total = 2000; const concurrency = 40;
async function worker() { while (true) { const index = next++; if (index >= total) return; const started = performance.now(); try { const response = await fetch(`${baseUrl}/api/stats`, { headers: { Authorization: `Bearer ${token}` } }); if (!response.ok) errors++; await response.arrayBuffer(); } catch { errors++; } latencies.push(performance.now() - started); } }
const started = performance.now(); await Promise.all(Array.from({ length: concurrency }, worker)); const elapsed = performance.now() - started;
latencies.sort((a, b) => a - b); const percentile = (p) => +latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * p))].toFixed(2);
const uploads = await Promise.all(Array.from({ length: 4 }, async (_, index) => { const form = new FormData(); form.set("file", new Blob([`并发上传 ${index} `.repeat(200)], { type: "text/plain" }), `${runId}-${index}.txt`); const response = await fetch(`${baseUrl}/api/documents`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: form }); return { status: response.status, body: await response.text() }; }));
const uploaded = uploads.find((item) => item.status === 201); const documentId = uploaded ? JSON.parse(uploaded.body).id : null;
const commentStatuses = documentId ? await Promise.all(Array.from({ length: 100 }, async (_, index) => { const response = await fetch(`${baseUrl}/api/documents/${documentId}/comments`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ content: `并发写入 ${index}` }) }); await response.arrayBuffer(); return response.status; })) : [];
const toggleStatuses = [];
if (documentId) for (let index = 0; index < 100; index += 1) { const response = await fetch(`${baseUrl}/api/documents/${documentId}/like`, { method: "POST", headers: { Authorization: `Bearer ${token}` } }); toggleStatuses.push(response.status); await response.arrayBuffer(); }
const report = { run_id: runId, requests: total, concurrency, errors, elapsed_ms: +elapsed.toFixed(2), rps: +(total / (elapsed / 1000)).toFixed(2), p50_ms: percentile(0.5), p95_ms: percentile(0.95), p99_ms: percentile(0.99), concurrent_upload_statuses: uploads.map((item) => item.status), concurrent_comment_statuses: Object.fromEntries([...new Set(commentStatuses)].map((status) => [status, commentStatuses.filter((value) => value === status).length])), sequential_toggle_statuses: Object.fromEntries([...new Set(toggleStatuses)].map((status) => [status, toggleStatuses.filter((value) => value === status).length])) };
await fs.mkdir(path.dirname(outputFile), { recursive: true }); await fs.writeFile(outputFile, JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
if (errors || uploads.some((item) => item.status !== 201) || commentStatuses.some((status) => status !== 201) || toggleStatuses.some((status) => status !== 200)) process.exitCode = 1;
