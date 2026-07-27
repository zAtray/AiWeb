import fs from "node:fs/promises";
import path from "node:path";
import type { Server } from "node:http";
import { createApp } from "./app.js";
import { dataDirectory, port } from "./config.js";

const totalRequests = Number(process.env.STRESS_REQUESTS ?? 2_000);
const concurrency = Number(process.env.STRESS_CONCURRENCY ?? 40);
const maxP95 = Number(process.env.STRESS_MAX_P95_MS ?? 2_500);
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

function percentile(values: number[], ratio: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))]!;
}

async function login(baseUrl: string): Promise<string> {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ account: "demo_001", password: "Demo@123" }),
  });
  if (!response.ok) {
    throw new Error("请先运行 npm run seed:demo 生成压力测试账号");
  }
  return ((await response.json()) as { token: string }).token;
}

async function main(): Promise<void> {
  const app = await createApp();
  const server = await new Promise<Server>((resolve) => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("服务启动失败");
  const baseUrl = `http://127.0.0.1:${address.port || port}`;
  const token = await login(baseUrl);
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
  const results: Result[] = [];
  let cursor = 0;
  const startedAt = performance.now();

  async function worker(): Promise<void> {
    while (cursor < totalRequests) {
      const index = cursor++;
      const selector = index % 20;
      let endpoint = "/api/documents?sort=hot";
      let init: RequestInit = { headers };
      if (selector < 10) {
        endpoint = `/api/search?q=${encodeURIComponent(queries[index % queries.length]!)}`;
      } else if (selector < 15) {
        endpoint = "/api/documents?scope=shared&sort=latest";
      } else if (selector < 18) {
        endpoint = "/api/stats";
      } else {
        endpoint = "/api/chat/ask";
        init = {
          method: "POST",
          headers,
          body: JSON.stringify({
            question: `${queries[index % queries.length]}如何实现？`,
          }),
        };
      }
      const requestStarted = performance.now();
      try {
        const response = await fetch(`${baseUrl}${endpoint}`, init);
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
  await new Promise<void>((resolve) => server.close(() => resolve()));

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
  const report = {
    generated_at: new Date().toISOString(),
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
        (durations.reduce((sum, value) => sum + value, 0) / durations.length).toFixed(
          1,
        ),
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
  await fs.writeFile(
    path.join(dataDirectory, "stress-report.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
  if (!report.pass) process.exitCode = 1;
}

await main();
