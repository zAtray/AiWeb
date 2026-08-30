import { AsyncLocalStorage } from "node:async_hooks";
import {
  createPool,
  type ExecuteValues,
  type Pool,
  type PoolConnection,
  type ResultSetHeader,
  type RowDataPacket,
} from "mysql2/promise";
import {
  dbConnectionLimit,
  dbHost,
  dbName,
  dbPassword,
  dbPort,
  dbUser,
  ensureDirectories,
} from "./config.js";
import type { SqlRow } from "./types.js";

export interface RunResult {
  lastInsertRowid: number;
  changes: number;
}

type QueryExecutor = Pool | PoolConnection;

let pool: Pool | undefined;
let initialized = false;
const transactionContext = new AsyncLocalStorage<PoolConnection>();

const schema = `
CREATE TABLE IF NOT EXISTS users (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  username VARCHAR(32) NOT NULL UNIQUE,
  email VARCHAR(120) NULL UNIQUE,
  phone VARCHAR(30) NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  role ENUM('user','department_admin','system_admin') NOT NULL DEFAULT 'user',
  created_at VARCHAR(32) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS auth_sessions (
  token_hash CHAR(64) NOT NULL PRIMARY KEY,
  user_id BIGINT UNSIGNED NOT NULL,
  expires_at VARCHAR(32) NOT NULL,
  created_at VARCHAR(32) NOT NULL,
  CONSTRAINT fk_auth_sessions_user
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS knowledge_bases (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  owner_id BIGINT UNSIGNED NOT NULL,
  name VARCHAR(80) NOT NULL,
  description VARCHAR(500) NOT NULL DEFAULT '',
  visibility ENUM('private','shared','public') NOT NULL DEFAULT 'private',
  created_at VARCHAR(32) NOT NULL,
  updated_at VARCHAR(32) NOT NULL,
  UNIQUE KEY uq_knowledge_bases_owner_name (owner_id,name),
  CONSTRAINT fk_knowledge_bases_owner
    FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS documents (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  owner_id BIGINT UNSIGNED NOT NULL,
  title VARCHAR(150) NOT NULL,
  filename VARCHAR(255) NOT NULL,
  stored_path VARCHAR(1024) NOT NULL,
  file_type VARCHAR(16) NOT NULL,
  file_size BIGINT UNSIGNED NOT NULL,
  category VARCHAR(50) NOT NULL DEFAULT '未分类',
  tags LONGTEXT NOT NULL,
  version INT UNSIGNED NOT NULL DEFAULT 1,
  text_content LONGTEXT NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'ready',
  share_status ENUM('private','pending','shared','rejected')
    NOT NULL DEFAULT 'private',
  share_note VARCHAR(300) NOT NULL DEFAULT '',
  views BIGINT UNSIGNED NOT NULL DEFAULT 0,
  downloads BIGINT UNSIGNED NOT NULL DEFAULT 0,
  created_at VARCHAR(32) NOT NULL,
  updated_at VARCHAR(32) NOT NULL,
  KEY idx_documents_owner (owner_id),
  KEY idx_documents_category (category),
  KEY idx_documents_share (share_status),
  CONSTRAINT fk_documents_owner
    FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS document_versions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  document_id BIGINT UNSIGNED NOT NULL,
  version INT UNSIGNED NOT NULL,
  filename VARCHAR(255) NOT NULL,
  stored_path VARCHAR(1024) NOT NULL,
  file_size BIGINT UNSIGNED NOT NULL,
  created_at VARCHAR(32) NOT NULL,
  UNIQUE KEY uq_document_versions_document_version (document_id,version),
  CONSTRAINT fk_document_versions_document
    FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS kb_documents (
  knowledge_base_id BIGINT UNSIGNED NOT NULL,
  document_id BIGINT UNSIGNED NOT NULL,
  added_at VARCHAR(32) NOT NULL,
  PRIMARY KEY (knowledge_base_id,document_id),
  KEY idx_kb_documents_document (document_id),
  CONSTRAINT fk_kb_documents_knowledge_base
    FOREIGN KEY (knowledge_base_id) REFERENCES knowledge_bases(id)
      ON DELETE CASCADE,
  CONSTRAINT fk_kb_documents_document
    FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS document_chunks (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  document_id BIGINT UNSIGNED NOT NULL,
  document_version INT UNSIGNED NOT NULL DEFAULT 1,
  chunk_index INT UNSIGNED NOT NULL,
  content LONGTEXT NOT NULL,
  page_start INT UNSIGNED NULL,
  page_end INT UNSIGNED NULL,
  chapter VARCHAR(160) NULL,
  section VARCHAR(220) NULL,
  content_type VARCHAR(20) NOT NULL DEFAULT 'content',
  quality_score DECIMAL(6,4) NOT NULL DEFAULT 1,
  UNIQUE KEY uq_document_chunks_document_index (document_id,chunk_index),
  KEY idx_chunks_document (document_id),
  KEY idx_chunks_document_chapter (document_id,chapter),
  CONSTRAINT fk_document_chunks_document
    FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS chunk_embeddings (
  chunk_id BIGINT UNSIGNED NOT NULL,
  provider VARCHAR(40) NOT NULL DEFAULT 'legacy',
  model VARCHAR(120) NOT NULL,
  dimensions INT UNSIGNED NOT NULL,
  generation VARCHAR(80) NOT NULL DEFAULT 'legacy',
  document_version INT UNSIGNED NOT NULL DEFAULT 0,
  stale TINYINT(1) NOT NULL DEFAULT 1,
  embedding LONGTEXT NOT NULL,
  updated_at VARCHAR(32) NOT NULL,
  PRIMARY KEY (chunk_id),
  KEY idx_chunk_embeddings_space (provider,model,generation,stale),
  CONSTRAINT fk_chunk_embeddings_chunk
    FOREIGN KEY (chunk_id) REFERENCES document_chunks(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS rag_chunk_search (
  chunk_id BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  document_id BIGINT UNSIGNED NOT NULL,
  document_version INT UNSIGNED NOT NULL,
  content LONGTEXT NOT NULL,
  title VARCHAR(150) NOT NULL,
  filename VARCHAR(255) NOT NULL,
  tags LONGTEXT NOT NULL,
  chapter VARCHAR(160) NULL,
  section VARCHAR(220) NULL,
  FULLTEXT KEY ft_rag_content (content,chapter,section) WITH PARSER ngram,
  FULLTEXT KEY ft_rag_metadata (title,filename,tags) WITH PARSER ngram,
  KEY idx_rag_search_document_version (document_id,document_version),
  CONSTRAINT fk_rag_search_chunk
    FOREIGN KEY (chunk_id) REFERENCES document_chunks(id) ON DELETE CASCADE,
  CONSTRAINT fk_rag_search_document
    FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS chat_sessions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT UNSIGNED NOT NULL,
  knowledge_base_id BIGINT UNSIGNED NULL,
  title VARCHAR(255) NOT NULL,
  created_at VARCHAR(32) NOT NULL,
  updated_at VARCHAR(32) NOT NULL,
  CONSTRAINT fk_chat_sessions_user
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_chat_sessions_knowledge_base
    FOREIGN KEY (knowledge_base_id) REFERENCES knowledge_bases(id)
      ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS messages (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  session_id BIGINT UNSIGNED NOT NULL,
  role ENUM('user','assistant') NOT NULL,
  content LONGTEXT NOT NULL,
  citations LONGTEXT NOT NULL,
  retrieval_state LONGTEXT NULL,
  created_at VARCHAR(32) NOT NULL,
  KEY idx_messages_session (session_id),
  CONSTRAINT fk_messages_session
    FOREIGN KEY (session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS favorites (
  user_id BIGINT UNSIGNED NOT NULL,
  document_id BIGINT UNSIGNED NOT NULL,
  created_at VARCHAR(32) NOT NULL,
  PRIMARY KEY (user_id,document_id),
  CONSTRAINT fk_favorites_user
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_favorites_document
    FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS likes (
  user_id BIGINT UNSIGNED NOT NULL,
  document_id BIGINT UNSIGNED NOT NULL,
  created_at VARCHAR(32) NOT NULL,
  PRIMARY KEY (user_id,document_id),
  CONSTRAINT fk_likes_user
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_likes_document
    FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS comments (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT UNSIGNED NOT NULL,
  document_id BIGINT UNSIGNED NOT NULL,
  content VARCHAR(500) NOT NULL,
  created_at VARCHAR(32) NOT NULL,
  CONSTRAINT fk_comments_user
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_comments_document
    FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS search_logs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT UNSIGNED NULL,
  query VARCHAR(500) NOT NULL,
  mode VARCHAR(32) NOT NULL,
  created_at VARCHAR(32) NOT NULL,
  KEY idx_search_query (query),
  CONSTRAINT fk_search_logs_user
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
`;

function executor(): QueryExecutor {
  return transactionContext.getStore() ?? getPool();
}

function getPool(): Pool {
  if (!pool) {
    pool = createPool({
      host: dbHost,
      port: dbPort,
      user: dbUser,
      password: dbPassword,
      database: dbName,
      waitForConnections: true,
      connectionLimit: dbConnectionLimit,
      queueLimit: 0,
      charset: "utf8mb4",
      multipleStatements: true,
      decimalNumbers: true,
    });
  }
  return pool;
}

class Statement {
  constructor(private readonly sql: string) {}

  async get(...parameters: ExecuteValues[]): Promise<SqlRow | undefined> {
    const [rows] = await executor().execute<RowDataPacket[]>(
      this.sql,
      parameters,
    );
    return rows[0] as SqlRow | undefined;
  }

  async all(...parameters: ExecuteValues[]): Promise<SqlRow[]> {
    const [rows] = await executor().execute<RowDataPacket[]>(
      this.sql,
      parameters,
    );
    return rows as SqlRow[];
  }

  async run(...parameters: ExecuteValues[]): Promise<RunResult> {
    const [result] = await executor().execute<ResultSetHeader>(
      this.sql,
      parameters,
    );
    return {
      lastInsertRowid: Number(result.insertId),
      changes: Number(result.affectedRows),
    };
  }
}

export interface Database {
  prepare(sql: string): Statement;
}

const database: Database = {
  prepare(sql: string) {
    return new Statement(sql);
  },
};

export async function initDb(): Promise<void> {
  if (initialized) return;
  ensureDirectories();
  await getPool().query(schema);
  const [chunkColumns] = await getPool().query<RowDataPacket[]>(
    "SHOW COLUMNS FROM document_chunks",
  );
  const existing = new Set(chunkColumns.map((row) => String(row.Field)));
  const additions = [
    ["document_version", "INT UNSIGNED NOT NULL DEFAULT 1 AFTER document_id"],
    ["page_start", "INT UNSIGNED NULL"],
    ["page_end", "INT UNSIGNED NULL"],
    ["chapter", "VARCHAR(160) NULL"],
    ["section", "VARCHAR(220) NULL"],
    ["content_type", "VARCHAR(20) NOT NULL DEFAULT 'content'"],
    ["quality_score", "DECIMAL(6,4) NOT NULL DEFAULT 1"],
  ] as const;
  for (const [column, definition] of additions) {
    if (!existing.has(column)) {
      await getPool().query(
        `ALTER TABLE document_chunks ADD COLUMN ${column} ${definition}`,
      );
    }
  }
  const [messageColumns] = await getPool().query<RowDataPacket[]>(
    "SHOW COLUMNS FROM messages",
  );
  if (!messageColumns.some((row) => String(row.Field) === "retrieval_state")) {
    await getPool().query(
      "ALTER TABLE messages ADD COLUMN retrieval_state LONGTEXT NULL AFTER citations",
    );
  }
  const [chunkIndexes] = await getPool().query<RowDataPacket[]>(
    "SHOW INDEX FROM document_chunks WHERE Key_name='idx_chunks_document_chapter'",
  );
  if (!chunkIndexes.length) {
    await getPool().query(
      "ALTER TABLE document_chunks ADD KEY idx_chunks_document_chapter (document_id,chapter)",
    );
  }
  const [embeddingColumns] = await getPool().query<RowDataPacket[]>(
    "SHOW COLUMNS FROM chunk_embeddings",
  );
  const embeddingExisting = new Set(
    embeddingColumns.map((row) => String(row.Field)),
  );
  const embeddingAdditions = [
    ["provider", "VARCHAR(40) NOT NULL DEFAULT 'legacy' AFTER chunk_id"],
    ["generation", "VARCHAR(80) NOT NULL DEFAULT 'legacy' AFTER dimensions"],
    ["document_version", "INT UNSIGNED NOT NULL DEFAULT 0 AFTER generation"],
    ["stale", "TINYINT(1) NOT NULL DEFAULT 1 AFTER document_version"],
  ] as const;
  for (const [column, definition] of embeddingAdditions) {
    if (!embeddingExisting.has(column)) {
      await getPool().query(
        `ALTER TABLE chunk_embeddings ADD COLUMN ${column} ${definition}`,
      );
    }
  }
  const [embeddingIndexes] = await getPool().query<RowDataPacket[]>(
    "SHOW INDEX FROM chunk_embeddings WHERE Key_name='idx_chunk_embeddings_space'",
  );
  if (!embeddingIndexes.length) {
    await getPool().query(
      "ALTER TABLE chunk_embeddings ADD KEY idx_chunk_embeddings_space (provider,model,generation,stale)",
    );
  }
  await getPool().query(
    `UPDATE document_chunks c JOIN documents d ON d.id=c.document_id
        SET c.document_version=d.version
      WHERE c.document_version<>d.version`,
  );
  await getPool().query(
    `INSERT INTO rag_chunk_search(
       chunk_id,document_id,document_version,content,title,filename,tags,chapter,section
     ) SELECT c.id,c.document_id,c.document_version,c.content,d.title,d.filename,d.tags,c.chapter,c.section
         FROM document_chunks c JOIN documents d ON d.id=c.document_id
     ON DUPLICATE KEY UPDATE
       document_id=VALUES(document_id),document_version=VALUES(document_version),
       content=VALUES(content),title=VALUES(title),filename=VALUES(filename),tags=VALUES(tags),
       chapter=VALUES(chapter),section=VALUES(section)`,
  );
  initialized = true;
}

export function getDb(): Database {
  return database;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export async function transaction<T>(work: () => Promise<T>): Promise<T> {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const connection = await getPool().getConnection();
    try {
      await connection.beginTransaction();
      const result = await transactionContext.run(connection, work);
      await connection.commit();
      return result;
    } catch (error) {
      await connection.rollback();
      const code = (error as { code?: string }).code;
      const retryable = code === "ER_LOCK_DEADLOCK" || code === "ER_LOCK_WAIT_TIMEOUT";
      if (!retryable || attempt === 3) throw error;
    } finally {
      connection.release();
    }
    await new Promise((resolve) => setTimeout(resolve, attempt * 25));
  }
  throw new Error("事务重试次数已耗尽");
}

export async function closeDb(): Promise<void> {
  await pool?.end();
  pool = undefined;
  initialized = false;
}

export async function databaseInfo(): Promise<{
  database: string;
  version: string;
}> {
  const row = await getDb()
    .prepare("SELECT DATABASE() AS database_name,VERSION() AS version")
    .get();
  return {
    database: String(row?.database_name ?? ""),
    version: String(row?.version ?? ""),
  };
}
