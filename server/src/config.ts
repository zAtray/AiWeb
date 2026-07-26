import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));

export const projectRoot = path.resolve(currentDirectory, "../..");
export const dataDirectory = path.resolve(
  process.env.APP_DATA_DIR ?? path.join(projectRoot, "data"),
);
export const uploadDirectory = path.join(dataDirectory, "uploads");
export const databasePath = path.resolve(
  process.env.DATABASE_PATH ?? path.join(dataDirectory, "knowledge.db"),
);
export const frontendDist = path.join(projectRoot, "frontend", "dist");
export const port = Number(process.env.APP_PORT ?? 8000);
export const sessionHours = Number(process.env.SESSION_HOURS ?? 24);
export const maxUploadBytes =
  Number(process.env.MAX_UPLOAD_MB ?? 20) * 1024 * 1024;
export const defaultAdminPassword =
  process.env.ADMIN_PASSWORD ?? "Admin@123";
export const allowedExtensions = new Set([".pdf", ".docx", ".txt", ".md"]);

export function ensureDirectories(): void {
  fs.mkdirSync(uploadDirectory, { recursive: true });
}

