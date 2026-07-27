import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));

export const projectRoot = path.resolve(currentDirectory, "../..");
try {
  process.loadEnvFile(path.join(projectRoot, ".env"));
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}

export const dataDirectory = path.resolve(
  process.env.APP_DATA_DIR ?? path.join(projectRoot, "data"),
);
export const uploadDirectory = path.join(dataDirectory, "uploads");
export const frontendDist = path.join(projectRoot, "frontend", "dist");
export const port = Number(process.env.APP_PORT ?? 8000);
export const sessionHours = Number(process.env.SESSION_HOURS ?? 24);
export const maxUploadBytes =
  Number(process.env.MAX_UPLOAD_MB ?? 20) * 1024 * 1024;
export const defaultAdminPassword =
  process.env.ADMIN_PASSWORD ?? "Admin@123";
export const allowedExtensions = new Set([".pdf", ".docx", ".txt", ".md"]);
export const dbHost = process.env.DB_HOST ?? "127.0.0.1";
export const dbPort = Number(process.env.DB_PORT ?? 3306);
export const dbUser = process.env.DB_USER ?? "";
export const dbPassword = process.env.DB_PASSWORD ?? "";
export const dbName = process.env.DB_NAME ?? "knowledge_platform";
export const dbConnectionLimit = Number(process.env.DB_CONNECTION_LIMIT ?? 10);

if (!dbUser) {
  throw new Error("缺少环境变量：DB_USER");
}

export function ensureDirectories(): void {
  fs.mkdirSync(uploadDirectory, { recursive: true });
}
