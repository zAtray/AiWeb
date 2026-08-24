import { describe, expect, it } from "vitest";
import {
  ApiError,
  documentJson,
  numberId,
  optionalText,
  parseTags,
  tagsFromJson,
  text,
} from "./core.js";
import {
  classifyQuery,
  isDocumentInventoryQuery,
  isSufficientlyRelevantEvidence,
} from "./retrieval.js";

describe("core validation", () => {
  it.each([[1, 1], ["42", 42]])("accepts safe IDs", (input, expected) => {
    expect(numberId(input)).toBe(expected);
  });

  it.each([0, -1, 1.5, "bad", Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid IDs",
    (input) => expect(() => numberId(input)).toThrow(ApiError),
  );

  it("trims required text", () => expect(text("  hello  ", "field")).toBe("hello"));
  it("rejects blank required text", () => expect(() => text("  ", "field")).toThrow("不能为空"));
  it("rejects overlong required text", () => expect(() => text("abcd", "field", 3)).toThrow("不能超过"));
  it("normalizes optional text", () => expect(optionalText("  note ", 10)).toBe("note"));
  it("rejects malformed optional text", () => expect(() => optionalText(12)).toThrow(ApiError));
  it("deduplicates and limits tags", () => {
    expect(parseTags("a，b,a,, c")).toEqual(["a", "b", "c"]);
    expect(parseTags(Array.from({ length: 25 }, (_, index) => `t${index}`))).toHaveLength(20);
  });
  it("reads valid tag JSON and tolerates corrupt JSON", () => {
    expect(tagsFromJson('["a","b"]')).toEqual(["a", "b"]);
    expect(tagsFromJson("not-json")).toEqual([]);
  });
  it("removes private document fields", () => {
    const result = documentJson({ stored_path: "secret", text_content: "private", tags: '["x"]', favorite: 1, liked: 0 });
    expect(result).toMatchObject({ tags: ["x"], favorite: true, liked: false });
    expect(result).not.toHaveProperty("stored_path");
    expect(result).not.toHaveProperty("text_content");
  });
});

describe("retrieval intent edges", () => {
  it("treats document types as content, not a document inventory request", () => {
    expect(isDocumentInventoryQuery("平台支持哪四类文档？")).toBe(false);
    expect(isDocumentInventoryQuery("平台支持哪四类文档，最大上传大小是多少？")).toBe(false);
    expect(isDocumentInventoryQuery("当前知识库有哪些文档？")).toBe(true);
  });
  it("recognizes natural overview wording", () => {
    expect(classifyQuery("请概览这份资料的主要章节。" )).toBe("overview");
  });
  it("accepts a strong hybrid hit even when Chinese phrase coverage is sparse", () => {
    expect(isSufficientlyRelevantEvidence("本平台是否依赖远程云数据库？", {
      id: 1,
      chunk_id: 1,
      document_id: 1,
      title: "系统架构",
      content: "平台完全运行在本机，数据库为 MySQL。",
      score: 0.46,
      lexical_score: 0.18,
    } as never)).toBe(true);
  });
});
