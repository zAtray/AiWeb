import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  pdfOcrBatchPages,
  pdfOcrDpi,
  pdfOcrEnabled,
  pdfInfoPath,
  pdfOcrLanguages,
  pdfOcrMaxPages,
  pdfOcrPageConcurrency,
  pdfOcrTempDirectory,
  pdfOcrTimeoutMs,
  pdfToPpmPath,
  tesseractPath,
} from "./config.js";
import { ApiError } from "./core.js";

const execFileAsync = promisify(execFile);

interface CommandOptions {
  timeout: number;
  maxBuffer: number;
}

interface CommandResult {
  stdout: string;
  stderr: string;
}

export type OcrCommandRunner = (
  command: string,
  args: string[],
  options: CommandOptions,
) => Promise<CommandResult>;

export interface PdfOcrOptions {
  enabled?: boolean;
  languages?: string;
  maxPages?: number;
  dpi?: number;
  timeoutMs?: number;
  batchPages?: number;
  pageConcurrency?: number;
  pages?: number[];
  temporaryRoot?: string;
  tesseractCommand?: string;
  pdfInfoCommand?: string;
  pdfToPpmCommand?: string;
  onProgress?: (completedPages: number, totalPages: number) => void;
  runner?: OcrCommandRunner;
}

export interface OcrPage {
  page: number;
  text: string;
}

export interface OcrCapability {
  enabled: boolean;
  available: boolean;
  languages: string[];
  missing: string[];
  message: string;
}

const defaultRunner: OcrCommandRunner = async (command, args, options) => {
  const result = await execFileAsync(command, args, {
    encoding: "utf8",
    timeout: options.timeout,
    maxBuffer: options.maxBuffer,
  });
  return { stdout: result.stdout, stderr: result.stderr };
};

function remainingTime(deadline: number): number {
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    throw new ApiError(408, "扫描 PDF 的 OCR 处理超时，请减少页数后重试");
  }
  return remaining;
}

function commandFailure(error: unknown, command: string): ApiError {
  const failure = error as NodeJS.ErrnoException & {
    killed?: boolean;
    signal?: string;
    stderr?: string;
  };
  if (failure.code === "ENOENT") {
    return new ApiError(
      503,
      `服务器缺少 OCR 组件 ${command}，请安装 Poppler 和 Tesseract`,
    );
  }
  if (failure.killed || failure.signal === "SIGTERM") {
    return new ApiError(408, "扫描 PDF 的 OCR 处理超时，请减少页数后重试");
  }
  const detail = failure.stderr?.trim();
  return new ApiError(
    422,
    detail
      ? `扫描 PDF 的 OCR 处理失败：${detail.slice(0, 300)}`
      : "扫描 PDF 的 OCR 处理失败，请确认文件没有损坏或加密",
  );
}

async function run(
  runner: OcrCommandRunner,
  command: string,
  args: string[],
  deadline: number,
  maxBuffer = 10 * 1024 * 1024,
): Promise<CommandResult> {
  try {
    return await runner(command, args, {
      timeout: remainingTime(deadline),
      maxBuffer,
    });
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw commandFailure(error, command);
  }
}

function requestedLanguages(value: string): string[] {
  const languages = value
    .split("+")
    .map((item) => item.trim())
    .filter(Boolean);
  if (
    !languages.length ||
    languages.some((language) => !/^[a-z0-9_]+$/iu.test(language))
  ) {
    throw new ApiError(500, "PDF_OCR_LANGUAGES 配置无效");
  }
  return languages;
}

export function pdfPageCount(output: string): number {
  const match = output.match(/^Pages:\s*(\d+)\s*$/imu);
  const pages = Number(match?.[1]);
  if (!Number.isInteger(pages) || pages < 1) {
    throw new ApiError(422, "无法读取扫描 PDF 的页数，请确认文件没有损坏或加密");
  }
  return pages;
}

function selectedPageRanges(pages: number[], batchPages: number): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let index = 0;
  while (index < pages.length) {
    const first = pages[index];
    let last = first;
    index += 1;
    while (
      index < pages.length &&
      pages[index] === last + 1 &&
      pages[index] - first < batchPages
    ) {
      last = pages[index];
      index += 1;
    }
    ranges.push([first, last]);
  }
  return ranges;
}

function pageNumber(filename: string): number {
  return Number(filename.match(/-(\d+)\.png$/u)?.[1] ?? 0);
}

export function normalizeOcrText(value: string): string {
  return value
    .replace(/([\p{Script=Han}])[ \t]+(?=[\p{Script=Han}])/gu, "$1")
    .replace(/[ \t]+\n/gu, "\n")
    .trim();
}

async function mapWithConcurrency<T, Result>(
  items: T[],
  concurrency: number,
  mapper: (item: T) => Promise<Result>,
): Promise<Result[]> {
  const results = new Array<Result>(items.length);
  let nextIndex = 0;
  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index]);
    }
  }
  await Promise.all(
    Array.from(
      { length: Math.min(concurrency, items.length) },
      () => worker(),
    ),
  );
  return results;
}

export async function ocrPdfPages(
  filePath: string,
  options: PdfOcrOptions = {},
): Promise<OcrPage[]> {
  const enabled = options.enabled ?? pdfOcrEnabled;
  if (!enabled) {
    throw new ApiError(
      503,
      "当前环境未启用扫描 PDF OCR，文本型 PDF 仍可正常处理",
    );
  }

  const languages = options.languages ?? pdfOcrLanguages;
  const languageList = requestedLanguages(languages);
  const maxPages = options.maxPages ?? pdfOcrMaxPages;
  const dpi = options.dpi ?? pdfOcrDpi;
  const timeoutMs = options.timeoutMs ?? pdfOcrTimeoutMs;
  const batchPages = Math.max(
    1,
    Math.floor(options.batchPages ?? pdfOcrBatchPages),
  );
  const pageConcurrency = Math.max(
    1,
    Math.floor(options.pageConcurrency ?? pdfOcrPageConcurrency),
  );
  const runner = options.runner ?? defaultRunner;
  const tesseractCommand = options.tesseractCommand ?? (
    options.runner ? "tesseract" : tesseractPath
  );
  const pdfInfoCommand = options.pdfInfoCommand ?? (
    options.runner ? "pdfinfo" : pdfInfoPath
  );
  const pdfToPpmCommand = options.pdfToPpmCommand ?? (
    options.runner ? "pdftoppm" : pdfToPpmPath
  );
  const deadline = Date.now() + timeoutMs;
  const temporaryRoot = path.resolve(options.temporaryRoot ?? pdfOcrTempDirectory);
  await fs.mkdir(temporaryRoot, { recursive: true });
  const temporaryDirectory = await fs.mkdtemp(
    path.join(temporaryRoot, "zhizhi-pdf-ocr-"),
  );

  try {
    // Validate the PDF itself before checking optional OCR dependencies so a
    // corrupt or encrypted upload is reported as a file error, not as a
    // missing Tesseract installation.
    const info = await run(runner, pdfInfoCommand, [filePath], deadline);
    const pageCount = pdfPageCount(info.stdout);
    if (pageCount > maxPages) {
      throw new ApiError(
        422,
        `扫描 PDF 共 ${pageCount} 页，超过自动 OCR 上限 ${maxPages} 页`,
      );
    }

    const languageResult = await run(
      runner,
      tesseractCommand,
      ["--list-langs"],
      deadline,
      1024 * 1024,
    );
    const installedLanguages = new Set(
      `${languageResult.stdout}\n${languageResult.stderr}`
        .split(/\r?\n/u)
        .map((item) => item.trim())
        .filter(Boolean),
    );
    const missingLanguages = languageList.filter(
      (language) => !installedLanguages.has(language),
    );
    if (missingLanguages.length) {
      throw new ApiError(
        503,
        `服务器缺少 OCR 语言包：${missingLanguages.join("、")}`,
      );
    }

    const selectedPages = options.pages
      ? [...new Set(options.pages)]
          .filter((page) => Number.isInteger(page) && page >= 1 && page <= pageCount)
          .sort((left, right) => left - right)
      : Array.from({ length: pageCount }, (_, index) => index + 1);
    if (!selectedPages.length) return [];

    const pagesWithText: OcrPage[] = [];
    let completedPages = 0;
    const outputPrefix = path.join(temporaryDirectory, "page");
    for (const [firstPage, lastPage] of selectedPageRanges(selectedPages, batchPages)) {
      let pageFiles: string[] = [];
      try {
        await run(
          runner,
          pdfToPpmCommand,
          [
            "-f",
            String(firstPage),
            "-l",
            String(lastPage),
            "-r",
            String(dpi),
            "-png",
            filePath,
            outputPrefix,
          ],
          deadline,
        );
        pageFiles = (await fs.readdir(temporaryDirectory))
          .filter((filename) => /^page-\d+\.png$/u.test(filename))
          .sort((left, right) => pageNumber(left) - pageNumber(right));
        if (pageFiles.length !== lastPage - firstPage + 1) {
          throw new ApiError(
            422,
            "扫描 PDF 转换图片失败，请确认文件没有损坏或加密",
          );
        }

        const batchTexts = await mapWithConcurrency(
          pageFiles,
          pageConcurrency,
          async (pageFile) => {
            const result = await run(
              runner,
              tesseractCommand,
              [
                path.join(temporaryDirectory, pageFile),
                "stdout",
                "-l",
                languages,
                "--dpi",
                String(dpi),
              ],
              deadline,
            );
            return {
              page: pageNumber(pageFile),
              text: normalizeOcrText(result.stdout),
            };
          },
        );
        pagesWithText.push(...batchTexts.filter((page) => Boolean(page.text)));
        completedPages += batchTexts.length;
        options.onProgress?.(completedPages, selectedPages.length);
      } finally {
        await Promise.all(
          pageFiles.map((pageFile) =>
            fs.rm(path.join(temporaryDirectory, pageFile), { force: true }),
          ),
        );
      }
    }
    return pagesWithText;
  } finally {
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }
}

let capabilityCache: { expiresAt: number; value: OcrCapability } | undefined;

export async function detectOcrCapability(
  runner: OcrCommandRunner = defaultRunner,
  useCache = runner === defaultRunner,
): Promise<OcrCapability> {
  if (!pdfOcrEnabled) {
    return {
      enabled: false,
      available: false,
      languages: [],
      missing: ["disabled"],
      message: "当前环境未启用扫描 PDF OCR，文本型 PDF 仍可正常处理。",
    };
  }
  if (useCache && capabilityCache && capabilityCache.expiresAt > Date.now()) {
    return capabilityCache.value;
  }
  const requiredLanguages = requestedLanguages(pdfOcrLanguages);
  const missing: string[] = [];
  let installedLanguages: string[] = [];
  const checks: Array<[string, string[], string]> = [
    [pdfInfoPath, ["-v"], "pdfinfo"],
    [pdfToPpmPath, ["-v"], "pdftoppm"],
  ];
  for (const [command, args, label] of checks) {
    try {
      await runner(command, args, { timeout: 3_000, maxBuffer: 1024 * 1024 });
    } catch {
      missing.push(label);
    }
  }
  try {
    const result = await runner(tesseractPath, ["--list-langs"], {
      timeout: 3_000,
      maxBuffer: 1024 * 1024,
    });
    installedLanguages = `${result.stdout}\n${result.stderr}`
      .split(/\r?\n/u)
      .map((item) => item.trim())
      .filter((item) => /^[a-z0-9_]+$/iu.test(item));
    for (const language of requiredLanguages) {
      if (!installedLanguages.includes(language)) missing.push(`lang:${language}`);
    }
  } catch {
    missing.push("tesseract");
  }
  const available = missing.length === 0;
  const value: OcrCapability = {
    enabled: true,
    available,
    languages: installedLanguages,
    missing,
    message: available
      ? "支持扫描 PDF OCR。"
      : "当前环境未完整启用扫描 PDF OCR，文本型 PDF 仍可正常处理。",
  };
  if (useCache) capabilityCache = { expiresAt: Date.now() + 60_000, value };
  return value;
}

export async function ocrPdf(
  filePath: string,
  options: PdfOcrOptions = {},
): Promise<string> {
  return (await ocrPdfPages(filePath, options))
    .map((page) => page.text)
    .join("\n\n");
}
