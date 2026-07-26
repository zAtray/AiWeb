import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "./auth.js";
import {
  ApiError,
  documentJson,
  numberId,
  parseTags,
  tagsFromJson,
  text,
} from "./core.js";
import { chunkText } from "./documents.js";
import { extractiveAnswer, lexicalScore, queryTerms } from "./search.js";

describe("公共逻辑单元测试", () => {
  it("校验并转换资源编号", () => {
    expect(numberId("12")).toBe(12);
    expect(() => numberId("0")).toThrow(ApiError);
    expect(() => numberId("abc")).toThrow("无效的资源编号");
  });

  it("统一清理文本参数", () => {
    expect(text("  知识管理  ", "标题")).toBe("知识管理");
    expect(() => text("", "标题")).toThrow("标题不能为空");
    expect(() => text("abcd", "标题", 3)).toThrow("不能超过");
  });

  it("标签支持中英文逗号、去重和数量限制", () => {
    expect(parseTags("检索，知识库,检索")).toEqual(["检索", "知识库"]);
    expect(parseTags(["A", " A ", "B"])).toEqual(["A", "B"]);
    expect(parseTags(null)).toEqual([]);
  });

  it("安全解析数据库标签并隐藏内部字段", () => {
    expect(tagsFromJson('["课程","测试"]')).toEqual(["课程", "测试"]);
    expect(tagsFromJson("broken")).toEqual([]);
    expect(
      documentJson({
        id: 1,
        tags: '["课程"]',
        favorite: 1,
        liked: 0,
        stored_path: "private",
        text_content: "private",
      }),
    ).toEqual({ id: 1, tags: ["课程"], favorite: true, liked: false });
  });

  it("密码哈希可验证且拒绝错误密码", () => {
    const encoded = hashPassword("Demo@123");
    expect(encoded).not.toContain("Demo@123");
    expect(verifyPassword("Demo@123", encoded)).toBe(true);
    expect(verifyPassword("wrong", encoded)).toBe(false);
  });

  it("长文本会分块且保留重叠上下文", () => {
    const chunks = chunkText("第一段。".repeat(80), 120, 20);
    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks.every((item) => item.length <= 120)).toBe(true);
    expect(chunkText("   ")).toEqual([]);
  });

  it("中文长查询会生成二字候选词", () => {
    expect(queryTerms("知识管理")).toEqual(
      expect.arrayContaining(["知识管理", "知识", "识管", "管理"]),
    );
  });

  it("标题和正文命中能得到稳定相关度", () => {
    const strong = lexicalScore(
      "全文检索",
      "系统支持全文检索并展示匹配片段。",
      "全文检索说明",
    );
    const weak = lexicalScore("全文检索", "用户注册与登录。", "账号说明");
    expect(strong).toBeGreaterThan(weak);
    expect(weak).toBe(0);
  });

  it("检索摘要包含引用，空结果给出明确提示", () => {
    const answer = extractiveAnswer("如何检索？", [
      {
        chunk_id: 1,
        chunk_index: 0,
        document_id: 1,
        title: "检索说明",
        category: "技术文档",
        tags: [],
        content: "系统支持全文检索。结果会显示原文片段。",
        score: 0.9,
      },
    ]);
    expect(answer).toContain("[1]");
    expect(extractiveAnswer("未知问题", [])).toContain("没有检索到");
  });
});

