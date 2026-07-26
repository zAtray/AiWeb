import type { Citation, SearchHit } from "./types.js";

export function queryTerms(query: string): string[] {
  const raw =
    query.toLowerCase().match(/[a-z0-9_]+|[\u4e00-\u9fff]+/gu) ?? [];
  const terms: string[] = [];
  for (const item of raw) {
    terms.push(item);
    if (/^[\u4e00-\u9fff]+$/u.test(item) && item.length >= 4) {
      for (let index = 0; index < item.length - 1; index += 1) {
        terms.push(item.slice(index, index + 2));
      }
    }
  }
  return [...new Set(terms)];
}

function occurrences(haystack: string, needle: string): number {
  let count = 0;
  let position = 0;
  while ((position = haystack.indexOf(needle, position)) >= 0) {
    count += 1;
    position += Math.max(needle.length, 1);
  }
  return count;
}

export function lexicalScore(
  query: string,
  content: string,
  title = "",
  tags = "",
): number {
  const terms = queryTerms(query);
  if (!terms.length) return 0;
  const contentText = content.toLowerCase();
  const titleText = title.toLowerCase();
  const tagText = tags.toLowerCase();
  const counts = terms.map(
    (term) =>
      occurrences(contentText, term) +
      occurrences(titleText, term) * 4 +
      occurrences(tagText, term) * 3,
  );
  const matched = counts.filter(Boolean).length;
  const coverage = matched / terms.length;
  const frequency = Math.min(
    1,
    counts.reduce((total, count) => total + count, 0) /
      Math.max(2, terms.length * 2),
  );
  const phraseBonus = `${titleText} ${contentText}`.includes(
    query.toLowerCase().trim(),
  )
    ? 0.2
    : 0;
  return Math.min(1, coverage * 0.62 + frequency * 0.28 + phraseBonus);
}

export function extractiveAnswer(
  question: string,
  results: SearchHit[],
): string {
  if (!results.length) {
    return "当前知识库中没有检索到足够相关的资料。请补充文档，或换一种更具体的问法。";
  }
  const selected: string[] = [];
  const seen = new Set<string>();
  results.slice(0, 4).forEach((item, index) => {
    const sentences = item.content
      .split(/(?<=[。！？!?])|\n+/u)
      .map((sentence) => sentence.trim())
      .filter(Boolean);
    const excerpt = sentences.slice(0, 2).join(" ").slice(0, 260);
    const signature = excerpt.replace(/\s+/g, "").slice(0, 80);
    if (excerpt && !seen.has(signature)) {
      selected.push(`${excerpt} [${index + 1}]`);
      seen.add(signature);
    }
  });
  return [
    `围绕“${question.trim()}”，知识库中可确认的信息如下：`,
    ...selected,
    "以上内容由本地全文检索结果整理，请结合引用原文核对。",
  ].join("\n\n");
}

export function toCitations(results: SearchHit[]): Citation[] {
  return results.map((item) => ({
    document_id: item.document_id,
    title: item.title,
    content: item.content.slice(0, 320),
    score: item.score,
  }));
}
