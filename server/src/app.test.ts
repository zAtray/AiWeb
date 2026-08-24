import { beforeAll, describe, expect, it } from "vitest";

const baseUrl = process.env.TEST_BASE_URL ?? "http://127.0.0.1:18080";
const runId = process.env.TEST_RUN_ID ?? `vitest_${Date.now()}`;
let token = "";
let userId = 0;

async function request(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (init.body && typeof init.body === "string") headers.set("Content-Type", "application/json");
  return fetch(`${baseUrl}${path}`, { ...init, headers });
}

beforeAll(async () => {
  const health = await fetch(`${baseUrl}/api/health`).then((response) => response.json());
  if (!String(health.database_name).startsWith("zhizhi_acceptance_")) {
    throw new Error(`Refusing integration tests against ${health.database_name}`);
  }
});

describe.sequential("running application contract", () => {
  it("serves health and local-only configuration", async () => {
    const response = await request("/api/health");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ status: "ok", app: "智知", remote_model_configured: false });
  });
  it("rejects protected routes without auth", async () => expect((await fetch(`${baseUrl}/api/stats`)).status).toBe(401));
  it("registers an isolated test user", async () => {
    const response = await request("/api/auth/register", { method: "POST", body: JSON.stringify({ username: runId, email: `${runId}@local.test`, phone: `9${Date.now()}`, password: "safe-pass-123" }) });
    expect(response.status).toBe(201);
    const body = await response.json(); token = body.token; userId = body.user.id;
    expect(userId).toBeGreaterThan(0);
  });
  it("returns the current user", async () => {
    const response = await request("/api/auth/me");
    expect(response.status).toBe(200);
    expect((await response.json()).id).toBe(userId);
  });
  it("creates, updates and deletes a knowledge base", async () => {
    const create = await request("/api/knowledge-bases", { method: "POST", body: JSON.stringify({ name: `${runId}-kb`, visibility: "private" }) });
    expect(create.status).toBe(201); const kb = await create.json();
    expect((await request("/api/knowledge-bases", { method: "POST", body: JSON.stringify({ name: `${runId}-kb` }) })).status).toBe(409);
    expect((await request(`/api/knowledge-bases/${kb.id}`, { method: "PUT", body: JSON.stringify({ name: `${runId}-renamed`, description: "updated", visibility: "shared" }) })).status).toBe(200);
    expect((await request(`/api/knowledge-bases/${kb.id}`, { method: "DELETE" })).status).toBe(204);
  });
  it("rejects invalid resource identifiers", async () => expect((await request("/api/documents/not-an-id")).status).toBe(400));
  it("returns stats for an authenticated user", async () => expect((await request("/api/stats")).status).toBe(200));
  it("logs out and invalidates the token", async () => {
    expect((await request("/api/auth/logout", { method: "POST" })).status).toBe(204);
    expect((await request("/api/auth/me")).status).toBe(401);
  });
});
