import fs from "node:fs/promises";
import path from "node:path";

const baseUrl = process.env.TEST_BASE_URL ?? "http://127.0.0.1:18080";
const outputFile = process.env.TEST_UI_REPORT_FILE ?? path.resolve("tests-output/ui-contract.json");
const checks = [];
function check(name, condition, detail = null) { checks.push({ name, status: condition ? "pass" : "fail", detail }); }
const healthResponse = await fetch(`${baseUrl}/api/health`); const health = await healthResponse.json();
if (!String(health.database_name).startsWith("zhizhi_acceptance_")) throw new Error(`Refusing UI acceptance against ${health.database_name}`);
check("health", healthResponse.ok && health.status === "ok", health);
const pageResponse = await fetch(`${baseUrl}/`); const html = await pageResponse.text(); check("SPA index", pageResponse.ok && html.includes('id="app"'));
const scriptPath = html.match(/<script[^>]+src="([^"]+)"/)?.[1]; const stylePath = html.match(/<link[^>]+href="([^"]+\.css)"/)?.[1];
const scriptResponse = scriptPath ? await fetch(`${baseUrl}${scriptPath}`) : null; const script = scriptResponse ? await scriptResponse.text() : "";
const styleResponse = stylePath ? await fetch(`${baseUrl}${stylePath}`) : null; const style = styleResponse ? await styleResponse.text() : "";
check("JavaScript asset", Boolean(scriptResponse?.ok && script.length > 100000), { scriptPath, bytes: script.length });
check("CSS asset", Boolean(styleResponse?.ok && style.length > 10000), { stylePath, bytes: style.length });
for (const label of ["登录工作台", "连接每一份知识", "我的会话", "知识库空间", "上传并建立索引", "从知识中找到证据", "知识广场", "个人中心", "共享文档审核"]) check(`view bundle: ${label}`, script.includes(label));
check("XSS sanitizer bundled", script.includes("DOMPurify") || script.includes("sanitize"));
const report = { base_url: baseUrl, tested_at: new Date().toISOString(), totals: { passed: checks.filter((item) => item.status === "pass").length, failed: checks.filter((item) => item.status === "fail").length }, checks };
await fs.mkdir(path.dirname(outputFile), { recursive: true }); await fs.writeFile(outputFile, JSON.stringify(report, null, 2)); console.log(JSON.stringify(report.totals)); if (report.totals.failed) process.exitCode = 1;
