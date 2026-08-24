import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import mammoth from "mammoth";
import pdf from "pdf-parse";
import { ocrPdf, ocrPdfPages, type OcrPage } from "./ocr.js";

const execFileAsync = promisify(execFile);

export interface ExtractedPage {
  page: number | null;
  text: string;
}

export interface ExtractedDocument {
  text: string;
  pages: ExtractedPage[];
  audit?: DocumentCleaningAudit;
}

export interface DocumentCleaningAudit {
  pageCount: number;
  textLayerPages: number;
  ocrPages: number;
  emptyPages: number;
  advertisementLines: number;
  repeatedMarginLines: number;
  pageNumberLines: number;
  replacementCharacters: number;
  privateUseCharacters: number;
  discardedLowQualityChunks: number;
  duplicateChunks: number;
  chapterCount: number;
}

export interface StructuredChunk {
  content: string;
  pageStart: number | null;
  pageEnd: number | null;
  chapter: string | null;
  section: string | null;
  contentType: "content" | "heading" | "toc";
  qualityScore: number;
}

interface ExtractTextOptions {
  parsePdf?: (bytes: Buffer) => Promise<{ text: string }>;
  parsePdfPages?: (bytes: Buffer) => Promise<ExtractedPage[]>;
  ocrPdf?: (filePath: string) => Promise<string>;
  ocrPdfPages?: (filePath: string, pages?: number[]) => Promise<OcrPage[]>;
}

const highConfidenceAdvertisement = [
  /购买.{0,20}(?:书|图书|课程|淘宝|店)/iu,
  /(?:taobao\.com|wangdao\.taobao\.com)/iu,
  /(?:兑换码|扫码添加|微信咨询|课程咨询|配套视频|盗版书)/u,
  /(?:邮购电话|质量投诉|侵权举报|图书有缺页)/u,
  /(?:王道训练营|就业咨询|获取就业数据)/u,
  /(?:bilibili(?:\.com)?|哔哩哔哩|扫码|二维码|QQ群|QQs*群)/iu,
  /(?:下载网站|高清带书签|电子书仅供|严禁传播|关注公众号|加群领取)/u,
  /(?:http(?:s)?:\/\/|www\.|\.com\b|\.cn\b)/iu,
  /购买王道.{0,8}(?:就上|书店)/u,
  /王道官方考研书店/u,
];

function normalizeLine(line: string): string {
  return line.replace(/[ \t]+/gu, " ").trim();
}

function lineSignature(line: string): string {
  return normalizeLine(line)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

function repeatedMargins(pages: ExtractedPage[]): Set<string> {
  const counts = new Map<string, Set<number>>();
  for (const page of pages) {
    if (page.page === null) continue;
    const lines = page.text.split(/\r?\n/u).map(normalizeLine).filter(Boolean);
    const margin = [...lines.slice(0, 3), ...lines.slice(-3)];
    for (const line of margin) {
      const signature = lineSignature(line);
      if (signature.length < 4 || signature.length > 100) continue;
      const seenPages = counts.get(signature) ?? new Set<number>();
      seenPages.add(page.page);
      counts.set(signature, seenPages);
    }
  }
  const threshold = Math.max(3, Math.ceil(pages.length * 0.015));
  return new Set(
    [...counts.entries()]
      .filter(([, seenPages]) => seenPages.size >= threshold)
      .map(([signature]) => signature),
  );
}

function isAdvertisement(line: string): boolean {
  return highConfidenceAdvertisement.some((pattern) => pattern.test(line));
}

export function isPdfNoiseLine(line: string): boolean {
  const normalized = normalizeLine(line);
  return (
    !normalized ||
    /^(?:第\s*)?[-—–·. ]*\d{1,4}[-—–·. ]*(?:页)?$/u.test(normalized) ||
    isAdvertisement(normalized) ||
    /[\uFFFD\uE000-\uF8FF]/u.test(normalized)
  );
}

function newAudit(pageCount: number): DocumentCleaningAudit {
  return {
    pageCount,
    textLayerPages: 0,
    ocrPages: 0,
    emptyPages: 0,
    advertisementLines: 0,
    repeatedMarginLines: 0,
    pageNumberLines: 0,
    replacementCharacters: 0,
    privateUseCharacters: 0,
    discardedLowQualityChunks: 0,
    duplicateChunks: 0,
    chapterCount: 0,
  };
}

function cleanPages(
  pages: ExtractedPage[],
  audit: DocumentCleaningAudit,
): ExtractedPage[] {
  const repeated = repeatedMargins(pages);
  return pages.map((page) => ({
    ...page,
    text: page.text
      .replace(/\r/gu, "")
      .replace(/[\uFFFD\uE000-\uF8FF]/gu, (character) => {
        if (character === "\uFFFD") audit.replacementCharacters += 1;
        else audit.privateUseCharacters += 1;
        return "";
      })
      .split("\n")
      .map(normalizeLine)
      .filter((line) => {
        if (!line) return false;
        if (/^(?:第\s*)?[-—–·. ]*\d{1,4}[-—–·. ]*(?:页)?$/u.test(line)) {
          audit.pageNumberLines += 1;
          return false;
        }
        if (isAdvertisement(line)) {
          audit.advertisementLines += 1;
          return false;
        }
        const signature = lineSignature(line);
        if (signature && repeated.has(signature)) {
          audit.repeatedMarginLines += 1;
          return false;
        }
        return true;
      })
      .join("\n")
      .trim(),
  }));
}

function meaningfulRatio(value: string): number {
  const compact = value.replace(/\s/gu, "");
  if (!compact) return 0;
  const meaningful = compact.match(/[\p{Script=Han}A-Za-z0-9]/gu)?.length ?? 0;
  return meaningful / compact.length;
}

function qualityScore(value: string): number {
  const compact = value.replace(/\s/gu, "");
  if (!compact) return 0;
  const replacementCount = value.match(/[\uFFFD\uE000-\uF8FF]/gu)?.length ?? 0;
  const ratio = meaningfulRatio(value);
  const replacementPenalty = replacementCount / compact.length;
  const isolatedNoise = value.match(/(?:\b[A-Za-z]\b[\s,.;:_-]*){8,}/gu)?.length ?? 0;
  return Math.max(
    0,
    Math.min(1, ratio - replacementPenalty * 4 - Math.min(0.35, isolatedNoise * 0.15)),
  );
}

export function hasReliableTextLayer(value: string): boolean {
  const meaningful = value.match(/[\p{Script=Han}A-Za-z0-9]/gu)?.length ?? 0;
  if (meaningful < 48 || qualityScore(value) < 0.62) return false;
  const lines = value.split(/\r?\n/u).map(normalizeLine).filter(Boolean);
  const usefulLines = lines.filter((line) => !isAdvertisement(line));
  return usefulLines.join("").length >= 40;
}

function chineseNumber(value: string): number | undefined {
  if (/^\d+$/u.test(value)) return Number(value);
  const digit: Record<string, number> = {
    零: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5,
    六: 6, 七: 7, 八: 8, 九: 9,
  };
  if (value in digit) return digit[value];
  if (value === "十") return 10;
  const match = value.match(/^([一二三四五六七八九])?十([一二三四五六七八九])?$/u);
  if (match) return (match[1] ? digit[match[1]] : 1) * 10 + (match[2] ? digit[match[2]] : 0);
  return undefined;
}

function chapterHeading(line: string): string | null {
  const match = normalizeLine(line).match(
    /^第\s*([0-9一二三四五六七八九十百]+)\s*章/u,
  );
  if (!match?.[1]) return null;
  const number = chineseNumber(match[1]);
  return `第${number ?? match[1]}章`;
}

function sectionHeading(line: string): string | null {
  const normalized = normalizeLine(line);
  const match = normalized.match(
    /^((?:[1-9]|10)\.\d{1,2}(?:\.\d{1,2})*)\s+[、._：:-]?\s*([\p{Script=Han}A-Za-z][^。！？!?]{0,49})/u,
  );
  return match ? `${match[1]} ${match[2]}`.trim() : null;
}

function looksLikeTocPage(text: string): boolean {
  const lines = text.split("\n").map(normalizeLine).filter(Boolean);
  if (lines.length < 4) return false;
  const leaderLines = lines.filter((line) => /(?:\.{3,}|…{2,})\s*\d*\s*$/u.test(line)).length;
  const outlineLines = lines.filter(
    (line) =>
      /^\d+\.\d+(?:\.\d+)*\s/u.test(line) ||
      /第\s*[0-9一二三四五六七八九十百]+\s*章/u.test(line) ||
      /\.{3,}|…{2,}/u.test(line),
  ).length;
  const proseLines = lines.filter(
    (line) => line.length >= 36 && /[。！？；]/u.test(line),
  ).length;
  return (
    leaderLines >= 2 ||
    (outlineLines / lines.length >= 0.45 && proseLines / lines.length < 0.2)
  );
}

async function renderPdfPages(bytes: Buffer): Promise<ExtractedPage[]> {
  const pages: ExtractedPage[] = [];
  await pdf(bytes, {
    pagerender: async (pageData: {
      pageNumber?: number;
      getTextContent: (options: {
        normalizeWhitespace: boolean;
        disableCombineTextItems: boolean;
      }) => Promise<{ items: Array<{ str?: string; transform?: number[] }> }>;
    }) => {
      const textContent = await pageData.getTextContent({
        normalizeWhitespace: false,
        disableCombineTextItems: false,
      });
      let lastY: number | undefined;
      let text = "";
      for (const item of textContent.items) {
        const y = item.transform?.[5];
        text += lastY === undefined || lastY === y ? item.str ?? "" : `\n${item.str ?? ""}`;
        lastY = y;
      }
      pages.push({ page: pageData.pageNumber ?? pages.length + 1, text: text.trim() });
      return text;
    },
  });
  return pages.sort((left, right) => (left.page ?? 0) - (right.page ?? 0));
}

async function popplerPdfPages(filePath: string): Promise<ExtractedPage[]> {
  const result = await execFileAsync(
    "pdftotext",
    ["-layout", "-enc", "UTF-8", filePath, "-"],
    {
      encoding: "utf8",
      timeout: 10 * 60 * 1000,
      maxBuffer: 256 * 1024 * 1024,
    },
  );
  return result.stdout
    .split("\f")
    .map((text, index) => ({ page: index + 1, text: text.trim() }))
    .filter((page) => page.text);
}

export function normalizeUploadFilename(filename: string): string {
  if (
    [...filename].some((character) => (character.codePointAt(0) ?? 0) > 255)
  ) {
    return filename;
  }
  const decoded = Buffer.from(filename, "latin1").toString("utf8");
  return decoded.includes("\uFFFD") ? filename : decoded;
}

export async function extractText(
  filePath: string,
  extension: string,
  options: ExtractTextOptions = {},
): Promise<string> {
  if (extension === ".txt" || extension === ".md") {
    const bytes = await fs.readFile(filePath);
    for (const encoding of ["utf-8", "gb18030"] as const) {
      try {
        return new TextDecoder(encoding, { fatal: true }).decode(bytes);
      } catch {
        // Try the next common encoding.
      }
    }
    throw new Error("文本文件编码无法识别");
  }
  if (extension === ".pdf") {
    const parsePdf = options.parsePdf ?? pdf;
    try {
      const result = await parsePdf(await fs.readFile(filePath));
      if (result.text.trim()) return result.text;
    } catch {
      // Poppler/Tesseract can still read some image PDFs rejected by pdf-parse.
    }
    return (options.ocrPdf ?? ocrPdf)(filePath);
  }
  if (extension === ".docx") {
    const result = await mammoth.extractRawText({ path: filePath });
    return result.value;
  }
  throw new Error(`不支持的文件类型：${path.extname(filePath)}`);
}

export async function extractDocument(
  filePath: string,
  extension: string,
  options: ExtractTextOptions = {},
): Promise<ExtractedDocument> {
  if (extension === ".pdf") {
    const bytes = await fs.readFile(filePath);
    let pages: ExtractedPage[] = [];
    try {
      if (options.parsePdfPages) {
        pages = await options.parsePdfPages(bytes);
      } else if (options.parsePdf) {
        const result = await options.parsePdf(bytes);
        if (result.text.trim()) pages = [{ page: null, text: result.text }];
      } else {
        try {
          pages = await popplerPdfPages(filePath);
        } catch {
          pages = await renderPdfPages(bytes);
        }
      }
    } catch {
      pages = [];
    }

    const numberedPages = pages.filter((page) => page.page !== null);
    const missingPages = numberedPages
      .filter((page) => !hasReliableTextLayer(page.text))
      .map((page) => page.page as number);
    const shouldOcrAll = pages.length === 0 || (
      pages.length === 1 && pages[0].page === null && !hasReliableTextLayer(pages[0].text)
    );
    let ocrPages: OcrPage[] = [];
    if (shouldOcrAll || missingPages.length) {
      if (options.ocrPdfPages) {
        ocrPages = await options.ocrPdfPages(
          filePath,
          shouldOcrAll ? undefined : missingPages,
        );
      } else if (options.ocrPdf) {
        const text = await options.ocrPdf(filePath);
        ocrPages = text.trim() ? [{ page: 1, text }] : [];
      } else {
        ocrPages = await ocrPdfPages(filePath, {
          pages: shouldOcrAll ? undefined : missingPages,
        });
      }
    }

    if (ocrPages.length) {
      const replacements = new Map(ocrPages.map((page) => [page.page, page.text]));
      if (numberedPages.length) {
        pages = pages.map((page) => page.page !== null && replacements.has(page.page)
          ? { page: page.page, text: replacements.get(page.page) ?? "" }
          : page);
      } else {
        pages = ocrPages;
      }
    }
    const audit = newAudit(pages.length);
    audit.ocrPages = ocrPages.length;
    audit.textLayerPages = pages.filter(
      (page) => page.page === null || !ocrPages.some((ocrPage) => ocrPage.page === page.page),
    ).filter((page) => hasReliableTextLayer(page.text)).length;
    audit.emptyPages = pages.filter((page) => !page.text.trim()).length;
    const text = pages.map((page) => page.text).filter(Boolean).join("\n\n");
    return { text, pages, audit };
  }
  const text = await extractText(filePath, extension, options);
  return { text, pages: [{ page: null, text }], audit: newAudit(1) };
}

export function chunkText(
  input: string,
  size = 760,
  overlap = 100,
): string[] {
  const normalized = input
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .trim();
  if (!normalized) return [];
  const blocks = normalized
    .split(/\n{2,}|(?<=[。！？!?])\s*/u)
    .map((block) => block.trim())
    .filter(Boolean);
  const chunks: string[] = [];
  let current = "";
  for (const block of blocks) {
    if (current.length + block.length + 1 <= size) {
      current = `${current}\n${block}`.trim();
      continue;
    }
    if (current) chunks.push(current);
    current = current ? `${current.slice(-overlap)}\n${block}`.trim() : block;
    while (current.length > size) {
      chunks.push(current.slice(0, size));
      current = current.slice(size - overlap);
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

export function structuredChunks(
  extracted: ExtractedDocument,
  size = 760,
  overlap = 100,
): StructuredChunk[] {
  const audit = extracted.audit ?? newAudit(extracted.pages.length);
  extracted.audit = audit;
  const pages = cleanPages(extracted.pages, audit);
  const chunks: StructuredChunk[] = [];
  let chapter: string | null = null;
  let section: string | null = null;

  for (const page of pages) {
    if (!page.text.trim()) continue;
    const contentType: StructuredChunk["contentType"] = looksLikeTocPage(page.text)
      ? "toc"
      : "content";
    const blocks = page.text
      .split(/\n{2,}|(?<=[。！？!?])\s*/u)
      .map((block) => block.trim())
      .filter(Boolean);
    let current = "";
    let currentType: StructuredChunk["contentType"] = contentType;
    const flush = () => {
      const content = current.trim();
      current = "";
      if (!content) return;
      const score = qualityScore(content);
      const meaningful = content.match(/[\p{Script=Han}A-Za-z0-9]/gu)?.length ?? 0;
      if (meaningful < 40 || score < 0.48 || isAdvertisement(content)) {
        audit.discardedLowQualityChunks += 1;
        return;
      }
      const finalType = looksLikeTocPage(content) ? "toc" : currentType;
      chunks.push({
        content,
        pageStart: page.page,
        pageEnd: page.page,
        chapter: finalType === "toc" ? null : chapter,
        section: finalType === "toc" ? null : section,
        contentType: finalType,
        qualityScore: Number(score.toFixed(4)),
      });
    };

    for (const block of blocks) {
      const lines = block.split("\n").map(normalizeLine).filter(Boolean);
      for (const line of lines) {
        const foundChapter = chapterHeading(line);
        const foundSection = sectionHeading(line);
        if (foundChapter || foundSection) {
          flush();
          if (contentType !== "toc") {
            if (foundChapter) {
              chapter = foundChapter;
              section = null;
            }
            if (foundSection) section = foundSection;
            if (foundSection) {
              const sectionChapter = foundSection.match(/^(\d+)\./u)?.[1];
              if (sectionChapter) chapter = `第${sectionChapter}章`;
            }
          }
          currentType = contentType === "toc" ? "toc" : "heading";
        }
        if (current.length + line.length + 1 > size) flush();
        current = `${current}\n${line}`.trim();
        if (current.length > size) {
          const head = current.slice(0, size);
          current = current.slice(Math.max(0, size - overlap));
          const score = qualityScore(head);
          if (score >= 0.48) {
            chunks.push({
              content: head,
              pageStart: page.page,
              pageEnd: page.page,
              chapter: currentType === "toc" ? null : chapter,
              section: currentType === "toc" ? null : section,
              contentType: currentType,
              qualityScore: Number(score.toFixed(4)),
            });
          }
        }
        if (currentType === "heading" && current.length > 160) currentType = "content";
      }
    }
    flush();
  }

  const seen = new Set<string>();
  const result = chunks.filter((chunk) => {
    const normalized = chunk.content.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
    const signature = normalized.length > 320
      ? `${normalized.slice(0, 180)}:${normalized.slice(-120)}`
      : normalized;
    if (!signature || seen.has(signature)) {
      audit.duplicateChunks += 1;
      return false;
    }
    seen.add(signature);
    return true;
  });
  audit.chapterCount = new Set(
    result.map((chunk) => chunk.chapter).filter((value): value is string => Boolean(value)),
  ).size;
  return result;
}
