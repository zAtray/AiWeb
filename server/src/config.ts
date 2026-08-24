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
const configuredMaxUploadMb = Number(process.env.MAX_UPLOAD_MB ?? 50);
export const maxUploadMb =
  Number.isFinite(configuredMaxUploadMb) && configuredMaxUploadMb > 0
    ? configuredMaxUploadMb
    : 50;
export const maxUploadBytes = maxUploadMb * 1024 * 1024;
export const uploadRequestTimeoutMs = Number(
  process.env.UPLOAD_REQUEST_TIMEOUT_MS ?? 50 * 60 * 1000,
);
export const pdfOcrEnabled =
  process.env.PDF_OCR_ENABLED?.trim().toLowerCase() !== "false";
export const pdfOcrLanguages =
  process.env.PDF_OCR_LANGUAGES?.trim() || "chi_sim+eng";
export const tesseractPath =
  process.env.TESSERACT_PATH?.trim() || "tesseract";
export const pdfInfoPath = process.env.PDFINFO_PATH?.trim() || "pdfinfo";
export const pdfToPpmPath = process.env.PDFTOPPM_PATH?.trim() || "pdftoppm";
export const pdfOcrTempDirectory = path.resolve(
  process.env.PDF_OCR_TEMP_DIR ?? path.join(dataDirectory, "ocr-temp"),
);
const configuredPdfOcrMaxPages = Number(process.env.PDF_OCR_MAX_PAGES ?? 500);
export const pdfOcrMaxPages = Number.isFinite(configuredPdfOcrMaxPages)
  ? Math.min(2_000, Math.max(1, Math.floor(configuredPdfOcrMaxPages)))
  : 500;
const configuredPdfOcrDpi = Number(process.env.PDF_OCR_DPI ?? 180);
export const pdfOcrDpi = Number.isFinite(configuredPdfOcrDpi)
  ? Math.min(400, Math.max(100, Math.floor(configuredPdfOcrDpi)))
  : 180;
const configuredPdfOcrTimeoutMs = Number(
  process.env.PDF_OCR_TIMEOUT_MS ?? 45 * 60 * 1000,
);
export const pdfOcrTimeoutMs = Number.isFinite(configuredPdfOcrTimeoutMs)
  ? Math.min(2 * 60 * 60 * 1000, Math.max(10_000, configuredPdfOcrTimeoutMs))
  : 45 * 60 * 1000;
const configuredPdfOcrBatchPages = Number(
  process.env.PDF_OCR_BATCH_PAGES ?? 8,
);
export const pdfOcrBatchPages = Number.isFinite(configuredPdfOcrBatchPages)
  ? Math.min(32, Math.max(1, Math.floor(configuredPdfOcrBatchPages)))
  : 8;
const configuredPdfOcrPageConcurrency = Number(
  process.env.PDF_OCR_PAGE_CONCURRENCY ?? 2,
);
export const pdfOcrPageConcurrency = Number.isFinite(
  configuredPdfOcrPageConcurrency,
)
  ? Math.min(4, Math.max(1, Math.floor(configuredPdfOcrPageConcurrency)))
  : 2;
export const defaultAdminPassword = (() => {
  const configuredPassword = process.env.ADMIN_PASSWORD?.trim();
  if (!configuredPassword) {
    throw new Error("缺少环境变量：ADMIN_PASSWORD");
  }
  return configuredPassword;
})();
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
  fs.mkdirSync(pdfOcrTempDirectory, { recursive: true });
}
