import fs from "node:fs/promises";
import path from "node:path";
import mammoth from "mammoth";
import pdf from "pdf-parse";

export async function extractText(
  filePath: string,
  extension: string,
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
    const result = await pdf(await fs.readFile(filePath));
    return result.text;
  }
  if (extension === ".docx") {
    const result = await mammoth.extractRawText({ path: filePath });
    return result.value;
  }
  throw new Error(`不支持的文件类型：${path.extname(filePath)}`);
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

