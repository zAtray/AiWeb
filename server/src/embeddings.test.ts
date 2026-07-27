import { describe, expect, it } from "vitest";
import { cosineSimilarity } from "./embeddings.js";

describe("向量相似度", () => {
  it("相同方向的向量相似度为 1", () => {
    expect(cosineSimilarity([1, 2, 3], [2, 4, 6])).toBeCloseTo(1);
  });

  it("正交向量相似度为 0", () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
  });

  it("维度不一致时拒绝比较", () => {
    expect(cosineSimilarity([1, 2], [1])).toBe(-1);
  });
});
