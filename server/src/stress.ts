import fs from "node:fs/promises";
import type { Server } from "node:http";
import { createApp } from "./app.js";
import { closeDb, getDb } from "./db.js";

const totalRequests = Number(process.env.STRESS_REQUESTS ?? 2_000);
const concurrency = Number(process.env.STRESS_CONCURRENCY ?? 40);
const maxP95 = Number(process.env.STRESS_MAX_P95_MS ?? 2_500);
const fixtureDocuments = Number(process.env.STRESS_DOCUMENTS ?? 24);
const runId = `${Date.now().toString(36)}${process.pid.toString(36)}`;
const username = `stress_${runId}`;
const password = "Stress@123";
const queries = [
  "知识管理",
  "全文检索",
  "共享审核",
  "权限控制",
  "数据统计",
  "文档版本",
];

interface Result {
  duration: number;
  ok: boolean;
  endpoint: string;
  status: number;
}

interface Fixture {
  token: string;
  userId: number;
  documentIds: number[];
}

interface StressReport {
  generated_at: string;
  scope: "non-ai";
  fixture_documents: number;
  requests: number;
  concurrency: number;
  elapsed_seconds: number;
  throughput_rps: number;
  errors: number;
  error_rate_percent: number;
  latency_ms: {
    average: number;
    p50: number;
    p95: number;
    p99: number;
    max: number;
  };
  endpoints: Record<
    string,
    { requests: number; errors: number; p95_ms: number }
  >;
  pass: boolean;
  threshold: { error_count: number; p95_ms: number };
}

function percentile(values: number[], ratio: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))]!;
}

async function createFixture(
  baseUrl: string,
  fixture: Fixture,
): Promise<void> {
  const register = await fetch(`${baseUrl}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username,
      email: `${username}@example.test`,
      password,
    }),
  });
  if (!register.ok) {
    throw new Error(`压力测试账号创建失败（HTTP ${register.status}）`);
  }
  const account = (await register.json()) as {
    token: string;
    user: { id: number };
  };
  fixture.token = account.token;
  fixture.userId = account.user.id;
  for (let index = 1; index <= fixtureDocuments; index += 1) {
    const topic = queries[index % queries.length]!;
    const content = [
      `非 AI 压力测试文档 ${index}：${topic}`,
      "系统支持文档上传、分类标签、历史版本、知识库权限与共享审核。",
      `全文检索需要根据${topic}返回原文片段，并记录本次检索活动。`,
      "本数据使用唯一测试账号创建，验收结束后会自动删除。",
    ].join("\n\n");
    const body = new FormData();
    body.set(
      "file",
      new Blob([content], { type: "text/plain" }),
      `stress-${runId}-${index}.txt`,
    );
    body.set("title", `非 AI 压测资料 ${index}`);
    body.set("category", "压力测试");
    body.set("tags", `${topic},非AI验收`);
    const upload = await fetch(`${baseUrl}/api/documents`, {
      method: "POST",
      headers: { Authorization: `Bearer ${account.token}` },
      body,
    });
    if (!upload.ok) {
      throw new Error(`压力测试文档创建失败（HTTP ${upload.status}）`);
    }
    fixture.documentIds.push(
      Number(((await upload.json()) as { id: number }).id),
    );
  }
}

async function cleanupFixture(
  baseUrl: string,
  token: string,
  userId: number,
  documentIds: number[],
): Promise<void> {
  const storedPaths = (
    await getDb()
      .prepare(
        `SELECT v.stored_path FROM document_versions v
         JOIN documents d ON d.id=v.document_id WHERE d.owner_id=?`,
      )
      .all(userId)
  ).map((row) => String(row.stored_path));

  await Promise.all(
    documentIds.map((id) =>
      fetch(`${baseUrl}/api/documents/${id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      }).catch(() => undefined),
    ),
  );
  await getDb()
    .prepare("DELETE FROM search_logs WHERE user_id=?")
    .run(userId);
  await getDb().prepare("DELETE FROM users WHERE id=?").run(userId);
  await Promise.all(
    [...new Set(storedPaths)].map((file) => fs.rm(file, { force: true })),
  );
}

async function runLoad(
  baseUrl: string,
  token: string,
): Promise<StressReport> {
  const headers = { Authorization: `Bearer ${token}` };
  const results: Result[] = [];
  let cursor = 0;
  const startedAt = performance.now();

  async function worker(): Promise<void> {
    while (cursor < totalRequests) {
      const index = cursor++;
      const selector = index % 20;
      const endpoint =
        selector < 10
          ? `/api/search?q=${encodeURIComponent(queries[index % queries.length]!)}`
          : selector < 16
            ? "/api/documents?sort=hot"
            : "/api/stats";
      const requestStarted = performance.now();
      try {
        const response = await fetch(`${baseUrl}${endpoint}`, { headers });
        await response.arrayBuffer();
        results.push({
          duration: performance.now() - requestStarted,
          ok: response.ok,
          endpoint: endpoint.split("?")[0]!,
          status: response.status,
        });
      } catch {
        results.push({
          duration: performance.now() - requestStarted,
          ok: false,
          endpoint: endpoint.split("?")[0]!,
          status: 0,
        });
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  const elapsed = performance.now() - startedAt;
  const durations = results.map((item) => item.duration);
  const failures = results.filter((item) => !item.ok);
  const endpointStats = Object.fromEntries(
    [...new Set(results.map((item) => item.endpoint))].map((endpoint) => {
      const matching = results.filter((item) => item.endpoint === endpoint);
      const matchingDurations = matching.map((item) => item.duration);
      return [
        endpoint,
        {
          requests: matching.length,
          errors: matching.filter((item) => !item.ok).length,
          p95_ms: Number(percentile(matchingDurations, 0.95).toFixed(1)),
        },
      ];
    }),
  );
  return {
    generated_at: new Date().toISOString(),
    scope: "non-ai",
    fixture_documents: fixtureDocuments,
    requests: results.length,
    concurrency,
    elapsed_seconds: Number((elapsed / 1_000).toFixed(2)),
    throughput_rps: Number((results.length / (elapsed / 1_000)).toFixed(1)),
    errors: failures.length,
    error_rate_percent: Number(
      ((failures.length / results.length) * 100).toFixed(2),
    ),
    latency_ms: {
      average: Number(
        (
          durations.reduce((sum, value) => sum + value, 0) / durations.length
        ).toFixed(1),
      ),
      p50: Number(percentile(durations, 0.5).toFixed(1)),
      p95: Number(percentile(durations, 0.95).toFixed(1)),
      p99: Number(percentile(durations, 0.99).toFixed(1)),
      max: Number(Math.max(...durations).toFixed(1)),
    },
    endpoints: endpointStats,
    pass: failures.length === 0 && percentile(durations, 0.95) <= maxP95,
    threshold: { error_count: 0, p95_ms: maxP95 },
  };
}

async function main(): Promise<void> {
  process.env.LOCAL_LLM_ENABLED = "false";
  process.env.EMBEDDING_ENABLED = "false";

  const app = await createApp();
  const server = await new Promise<Server>((resolve) => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("服务启动失败");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const fixture: Fixture = { token: "", userId: 0, documentIds: [] };

  try {
    await createFixture(baseUrl, fixture);
    const report = await runLoad(baseUrl, fixture.token);
    await fs.writeFile(
      new URL("../../data/stress-report.json", import.meta.url),
      JSON.stringify(report, null, 2),
    );
    console.log(JSON.stringify(report, null, 2));
    if (!report.pass) process.exitCode = 1;
  } finally {
    if (fixture.userId) {
      await cleanupFixture(
        baseUrl,
        fixture.token,
        fixture.userId,
        fixture.documentIds,
      );
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

try {
  await main();
} finally {
  await closeDb();
}
