import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import supertest from "supertest";

let temporaryDirectory = "";
let request: ReturnType<typeof supertest>;
let closeDatabase: () => Promise<void>;
let databaseModule: typeof import("./db.js");
let userToken = "";
let documentId = 0;

beforeAll(async () => {
  temporaryDirectory = await fs.mkdtemp(
    path.join(process.cwd(), "data", "test-"),
  );
  process.env.APP_DATA_DIR = temporaryDirectory;
  process.env.ADMIN_PASSWORD = "Admin@123";
  process.env.LOCAL_LLM_ENABLED = "false";
  process.env.EMBEDDING_ENABLED = "false";
  const [appModule, loadedDatabaseModule] = await Promise.all([
    import("./app.js"),
    import("./db.js"),
  ]);
  databaseModule = loadedDatabaseModule;
  closeDatabase = databaseModule.closeDb;
  request = supertest(await appModule.createApp());
  await databaseModule
    .getDb()
    .prepare("DELETE FROM users WHERE username=?")
    .run("student");
});

afterAll(async () => {
  await databaseModule
    .getDb()
    .prepare("DELETE FROM users WHERE username=?")
    .run("student");
  await closeDatabase();
  await fs.rm(temporaryDirectory, { recursive: true, force: true });
});

describe("实验二核心业务闭环", () => {
  it("注册用户并创建知识库", async () => {
    const register = await request.post("/api/auth/register").send({
      username: "student",
      password: "Student123",
      email: "student@example.test",
    });
    expect(register.status).toBe(201);
    userToken = register.body.token;

    const knowledgeBase = await request
      .post("/api/knowledge-bases")
      .set("Authorization", `Bearer ${userToken}`)
      .send({
        name: "课程资料",
        description: "实验二验机资料",
        visibility: "private",
      });
    expect(knowledgeBase.status).toBe(201);
    expect(knowledgeBase.body.name).toBe("课程资料");
  });

  it("上传、解析、检索文档并生成带引用的检索摘要", async () => {
    const upload = await request
      .post("/api/documents")
      .set("Authorization", `Bearer ${userToken}`)
      .field("title", "实验二功能说明")
      .field("category", "课程资料")
      .field("tags", "实验二,知识管理")
      .attach(
        "file",
        Buffer.from(
          "实验二需要实现知识文档管理、知识库管理、全文检索、共享审核与统计分析。用户可以继续追问并查看引用片段。",
        ),
        { filename: "experiment-two.txt", contentType: "text/plain" },
      );
    expect(upload.status).toBe(201);
    expect(upload.body.chunk_count).toBeGreaterThan(0);
    documentId = upload.body.id;

    const search = await request
      .get("/api/search")
      .query({ q: "知识管理" })
      .set("Authorization", `Bearer ${userToken}`);
    expect(search.status).toBe(200);
    expect(search.body.results[0].document_id).toBe(documentId);

    const answer = await request
      .post("/api/chat/ask")
      .set("Authorization", `Bearer ${userToken}`)
      .send({ question: "实验二需要实现哪些功能？" });
    expect(answer.status).toBe(200);
    expect(answer.body.engine).toBe("local-extractive");
    expect(answer.body.citations.length).toBeGreaterThan(0);
  });

  it("完成点赞、收藏、评论与共享审核", async () => {
    for (const action of ["like", "favorite"]) {
      const result = await request
        .post(`/api/documents/${documentId}/${action}`)
        .set("Authorization", `Bearer ${userToken}`);
      expect(result.status).toBe(200);
      expect(result.body.active).toBe(true);
    }
    const comment = await request
      .post(`/api/documents/${documentId}/comments`)
      .set("Authorization", `Bearer ${userToken}`)
      .send({ content: "这份资料很完整。" });
    expect(comment.status).toBe(201);

    const share = await request
      .post(`/api/documents/${documentId}/share`)
      .set("Authorization", `Bearer ${userToken}`);
    expect(share.status).toBe(200);

    const login = await request
      .post("/api/auth/login")
      .send({ account: "admin", password: "Admin@123" });
    const adminToken = login.body.token;
    const pending = await request
      .get("/api/admin/share-requests")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(pending.body.some((item: { id: number }) => item.id === documentId)).toBe(
      true,
    );

    const review = await request
      .post(`/api/admin/documents/${documentId}/review`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ approved: true, note: "" });
    expect(review.status).toBe(200);
    expect(review.body.share_status).toBe("shared");
  });

  it("返回统计数据且明确未配置远程模型", async () => {
    const stats = await request
      .get("/api/stats")
      .set("Authorization", `Bearer ${userToken}`);
    expect(stats.status).toBe(200);
    expect(stats.body.documents).toBe(1);
    expect(stats.body.searches).toBeGreaterThanOrEqual(2);

    const health = await request.get("/api/health");
    expect(health.body.remote_model_configured).toBe(false);
    expect(health.body.answer_engine).toBe("local-extractive");
    expect(health.body.retrieval_engine).toBe("lexical");
    expect(health.body.embedding_model_configured).toBe(false);
  });
});
