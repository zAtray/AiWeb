import { describe, expect, it } from "vitest";
import {
  chunkText,
  hasReliableTextLayer,
  isPdfNoiseLine,
  normalizeUploadFilename,
  structuredChunks,
} from "./documents.js";

describe("document processing", () => {
  it.each(["1", "第 12 页", "--- 99 ---", "扫码关注公众号"]) (
    "filters known PDF noise: %s",
    (line) => expect(isPdfNoiseLine(line)).toBe(true),
  );
  it("keeps normal prose", () => expect(isPdfNoiseLine("这是有效的知识内容。")) .toBe(false));
  it("requires a meaningful text layer", () => {
    expect(hasReliableTextLayer("短文本")).toBe(false);
    expect(hasReliableTextLayer("这是用于验证 PDF 文本层可靠性的完整中文句子。".repeat(8))).toBe(true);
  });
  it("preserves Unicode filenames", () => expect(normalizeUploadFilename("中文文档.pdf")).toBe("中文文档.pdf"));
  it("decodes UTF-8 names received as latin1", () => {
    const mojibake = Buffer.from("中文.txt", "utf8").toString("latin1");
    expect(normalizeUploadFilename(mojibake)).toBe("中文.txt");
  });
  it("returns no chunks for blank text", () => expect(chunkText(" \n\t ")).toEqual([]));
  it("honors size and overlap", () => {
    const chunks = chunkText("甲".repeat(500), 120, 20);
    expect(chunks.length).toBeGreaterThan(3);
    expect(chunks.every((item) => item.length <= 120)).toBe(true);
    expect(chunks[0]!.slice(-20)).toBe(chunks[1]!.slice(0, 20));
  });
  it("detects chapter and section structure", () => {
    const text = "第一章 平台介绍\n\n1.1 功能范围\n\n" + "本节介绍本地知识平台的核心能力与安全边界。".repeat(12);
    const extracted = { text, pages: [{ page: 1, text }], audit: undefined };
    const chunks = structuredChunks(extracted, 300, 40);
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.some((item) => item.chapter === "第1章")).toBe(true);
  });
});
