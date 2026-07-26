import fs from "node:fs/promises";
import path from "node:path";
import { hashPassword } from "./auth.js";
import { dataDirectory, uploadDirectory } from "./config.js";
import { getDb, nowIso, transaction } from "./db.js";

type Profile = "small" | "medium" | "large";

const profiles = {
  small: {
    users: 12,
    knowledgeBases: 8,
    documents: 80,
    chunksPerDocument: 8,
    searchLogs: 1_000,
    chatSessions: 100,
    likes: 500,
    favorites: 350,
    comments: 300,
  },
  medium: {
    users: 40,
    knowledgeBases: 18,
    documents: 300,
    chunksPerDocument: 15,
    searchLogs: 6_000,
    chatSessions: 500,
    likes: 2_500,
    favorites: 1_800,
    comments: 1_600,
  },
  large: {
    users: 100,
    knowledgeBases: 50,
    documents: 1_000,
    chunksPerDocument: 20,
    searchLogs: 20_000,
    chatSessions: 2_000,
    likes: 10_000,
    favorites: 7_000,
    comments: 6_000,
  },
} as const;

const profileName = (process.env.DEMO_SCALE ?? "medium") as Profile;
const profile = profiles[profileName];
if (!profile) {
  throw new Error("DEMO_SCALE 仅支持 small、medium、large");
}

let randomState = Number(process.env.DEMO_SEED ?? 20260725) >>> 0;
function random(): number {
  randomState = (randomState * 1_664_525 + 1_013_904_223) >>> 0;
  return randomState / 0x1_0000_0000;
}

function pick<T>(values: readonly T[]): T {
  return values[Math.floor(random() * values.length)]!;
}

function randomDate(days = 120): string {
  return new Date(Date.now() - random() * days * 86_400_000).toISOString();
}

const categories = [
  "课程资料",
  "技术文档",
  "项目规范",
  "会议纪要",
  "产品手册",
  "培训资料",
] as const;
const topics = [
  "知识管理",
  "全文检索",
  "共享审核",
  "权限控制",
  "数据统计",
  "文档版本",
  "课程设计",
  "系统测试",
] as const;

function documentText(index: number, category: string, topic: string): string {
  return [
    `演示文档 ${index}：${topic}`,
    `本资料属于${category}，用于验证实验二的知识管理平台。`,
    `系统支持用户注册登录、文档上传、分类标签、历史版本和知识库权限管理。`,
    `全文检索会返回匹配片段，并根据${topic}推荐相关知识文档。`,
    `用户可以收藏、点赞、评论，管理员负责共享审核。`,
    `统计模块记录访问、下载、检索和问答次数。`,
  ].join("\n\n");
}

async function removeOldDemoFiles(): Promise<void> {
  const names = await fs.readdir(uploadDirectory).catch(() => []);
  await Promise.all(
    names
      .filter((name) => name.startsWith("demo-"))
      .map((name) => fs.rm(path.join(uploadDirectory, name), { force: true })),
  );
}

async function main(): Promise<void> {
  const startedAt = performance.now();
  const db = getDb();
  await removeOldDemoFiles();

  const passwordHash = hashPassword("Demo@123");
  const userIds: number[] = [];
  const kbIds: number[] = [];
  const documentIds: number[] = [];

  transaction(() => {
    db.prepare("DELETE FROM search_logs WHERE mode='demo'").run();
    db.prepare("DELETE FROM users WHERE username LIKE 'demo_%'").run();

    const insertUser = db.prepare(
      `INSERT INTO users(username,email,password_hash,role,created_at)
       VALUES (?,?,?,?,?)`,
    );
    for (let index = 1; index <= profile.users; index += 1) {
      const result = insertUser.run(
        `demo_${String(index).padStart(3, "0")}`,
        `demo${index}@example.test`,
        passwordHash,
        index <= 3 ? "department_admin" : "user",
        randomDate(),
      );
      userIds.push(Number(result.lastInsertRowid));
    }

    const insertKb = db.prepare(
      `INSERT INTO knowledge_bases(
        owner_id,name,description,visibility,created_at,updated_at
       ) VALUES (?,?,?,?,?,?)`,
    );
    for (let index = 1; index <= profile.knowledgeBases; index += 1) {
      const date = randomDate();
      const result = insertKb.run(
        pick(userIds),
        `[演示] ${pick(topics)}资料库 ${index}`,
        "压力测试与课程验机使用的可重复演示数据",
        index % 3 === 0 ? "private" : "shared",
        date,
        date,
      );
      kbIds.push(Number(result.lastInsertRowid));
    }
  });

  const files = Array.from({ length: profile.documents }, (_, offset) => {
    const index = offset + 1;
    const category = pick(categories);
    const topic = pick(topics);
    const content = documentText(index, category, topic);
    const storedPath = path.join(
      uploadDirectory,
      `demo-${String(index).padStart(4, "0")}.txt`,
    );
    return { index, category, topic, content, storedPath };
  });
  await Promise.all(
    files.map((file) => fs.writeFile(file.storedPath, file.content, "utf8")),
  );

  transaction(() => {
    const insertDocument = db.prepare(
      `INSERT INTO documents(
        owner_id,title,filename,stored_path,file_type,file_size,category,tags,
        text_content,status,share_status,views,downloads,created_at,updated_at
       ) VALUES (?,?,?,?,?,?,?,?,?,'ready',?,?,?,?,?)`,
    );
    const insertVersion = db.prepare(
      `INSERT INTO document_versions(
        document_id,version,filename,stored_path,file_size,created_at
       ) VALUES (?,1,?,?,?,?)`,
    );
    const insertChunk = db.prepare(
      `INSERT INTO document_chunks(document_id,chunk_index,content)
       VALUES (?,?,?)`,
    );
    const assignKb = db.prepare(
      `INSERT OR IGNORE INTO kb_documents(
        knowledge_base_id,document_id,added_at
       ) VALUES (?,?,?)`,
    );

    for (const file of files) {
      const date = randomDate();
      const shareStatus =
        file.index % 7 === 0
          ? "pending"
          : file.index % 5 === 0
            ? "private"
            : "shared";
      const result = insertDocument.run(
        pick(userIds),
        `[演示] ${file.topic}案例 ${file.index}`,
        path.basename(file.storedPath),
        file.storedPath,
        "TXT",
        Buffer.byteLength(file.content),
        file.category,
        JSON.stringify([file.topic, "演示数据", `批次${file.index % 10}`]),
        file.content,
        shareStatus,
        Math.floor(random() * 2_000),
        Math.floor(random() * 500),
        date,
        date,
      );
      const documentId = Number(result.lastInsertRowid);
      documentIds.push(documentId);
      insertVersion.run(
        documentId,
        path.basename(file.storedPath),
        file.storedPath,
        Buffer.byteLength(file.content),
        date,
      );
      for (
        let chunkIndex = 0;
        chunkIndex < profile.chunksPerDocument;
        chunkIndex += 1
      ) {
        const secondaryTopic = topics[(file.index + chunkIndex) % topics.length]!;
        insertChunk.run(
          documentId,
          chunkIndex,
          `${file.content}\n\n片段 ${chunkIndex + 1} 重点说明${secondaryTopic}的实现、测试与验收方法。`,
        );
      }
      assignKb.run(pick(kbIds), documentId, date);
      assignKb.run(pick(kbIds), documentId, date);
    }

    const insertRelation = (
      table: "likes" | "favorites",
      total: number,
    ): void => {
      const statement = db.prepare(
        `INSERT OR IGNORE INTO ${table}(user_id,document_id,created_at)
         VALUES (?,?,?)`,
      );
      for (let index = 0; index < total; index += 1) {
        statement.run(pick(userIds), pick(documentIds), randomDate());
      }
    };
    insertRelation("likes", profile.likes);
    insertRelation("favorites", profile.favorites);

    const insertComment = db.prepare(
      `INSERT INTO comments(user_id,document_id,content,created_at)
       VALUES (?,?,?,?)`,
    );
    for (let index = 0; index < profile.comments; index += 1) {
      insertComment.run(
        pick(userIds),
        pick(documentIds),
        `演示评论 ${index + 1}：该资料对${pick(topics)}的说明很清楚。`,
        randomDate(),
      );
    }

    const insertLog = db.prepare(
      `INSERT INTO search_logs(user_id,query,mode,created_at)
       VALUES (?,?,'demo',?)`,
    );
    for (let index = 0; index < profile.searchLogs; index += 1) {
      insertLog.run(pick(userIds), pick(topics), randomDate(30));
    }

    const insertSession = db.prepare(
      `INSERT INTO chat_sessions(
        user_id,knowledge_base_id,title,created_at,updated_at
       ) VALUES (?,?,?,?,?)`,
    );
    const insertMessage = db.prepare(
      `INSERT INTO messages(session_id,role,content,citations,created_at)
       VALUES (?,?,?,?,?)`,
    );
    for (let index = 0; index < profile.chatSessions; index += 1) {
      const topic = pick(topics);
      const date = randomDate(30);
      const session = insertSession.run(
        pick(userIds),
        pick(kbIds),
        `${topic}如何实现？`,
        date,
        date,
      );
      const sessionId = Number(session.lastInsertRowid);
      insertMessage.run(sessionId, "user", `${topic}如何实现？`, "[]", date);
      insertMessage.run(
        sessionId,
        "assistant",
        `根据演示知识库，${topic}需要结合需求、代码和测试数据进行验证。[1]`,
        JSON.stringify([
          {
            document_id: pick(documentIds),
            title: `${topic}演示资料`,
            content: "演示引用片段",
            score: 0.9,
          },
        ]),
        date,
      );
    }
  });

  const counts = Object.fromEntries(
    [
      "users",
      "knowledge_bases",
      "documents",
      "document_chunks",
      "likes",
      "favorites",
      "comments",
      "search_logs",
      "chat_sessions",
      "messages",
    ].map((table) => [
      table,
      Number(
        (
          db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
            count: number;
          }
        ).count,
      ),
    ]),
  );
  const report = {
    profile: profileName,
    generated_at: nowIso(),
    elapsed_ms: Math.round(performance.now() - startedAt),
    demo_login: { account: "demo_001", password: "Demo@123" },
    counts,
  };
  await fs.writeFile(
    path.join(dataDirectory, "seed-report.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
}

await main();

