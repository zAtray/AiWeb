import type { Citation, SearchHit } from "./types.js";

const searchIntentWords = [
  "请",
  "帮我",
  "一下",
  "给出",
  "总结",
  "概括",
  "介绍",
  "讲解",
  "说明",
  "详细",
  "展开",
  "内容",
];

function normalizedSearchQuery(query: string): string {
  let normalized = query.toLowerCase().replace(/计组/gu, "计算机组成原理");
  for (const word of searchIntentWords) {
    normalized = normalized.replaceAll(word, " ");
  }
  return normalized;
}

export function queryTerms(query: string): string[] {
  const raw =
    normalizedSearchQuery(query).match(/[a-z0-9_]+|[\u4e00-\u9fff]+/gu) ?? [];
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

function chapterMarkers(query: string): string[] {
  const compact = query.replace(/\s+/gu, "");
  const match = compact.match(/第([0-9一二三四五六七八九十百]+)章/u);
  if (!match?.[1]) return [];
  const value = match[1];
  const chineseNumbers: Record<string, string> = {
    一: "1",
    二: "2",
    三: "3",
    四: "4",
    五: "5",
    六: "6",
    七: "7",
    八: "8",
    九: "9",
    十: "10",
  };
  const alternate = chineseNumbers[value];
  return [...new Set([`第${value}章`, alternate ? `第${alternate}章` : ""])].filter(
    Boolean,
  );
}

/**
 * Chapter questions normally target one book. Keeping equally vague hits from
 * other books makes both the model and the citation list misleading.
 */
export function selectAnswerContexts(
  query: string,
  results: SearchHit[],
  limit = 5,
): SearchHit[] {
  if (!results.length) return [];
  const markers = chapterMarkers(query);
  if (!markers.length) return results.slice(0, limit);

  const matchingChapter = results.filter((item) => {
    const text = `${item.title}${item.chapter ?? ""}${item.section ?? ""}${item.content}`
      .replace(/\s+/gu, "");
    return markers.some((marker) => text.includes(marker));
  });
  const anchor = matchingChapter[0] ?? results[0];
  const sameDocument = results.filter(
    (item) => item.document_id === anchor.document_id,
  );
  if (matchingChapter.length) {
    return matchingChapter
      .filter((item) => item.document_id === anchor.document_id)
      .slice(0, limit);
  }
  const ordered = [
    ...sameDocument.filter((item) => matchingChapter.includes(item)),
    ...sameDocument.filter((item) => !matchingChapter.includes(item)),
  ];
  return ordered.slice(0, limit);
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

export function groundedOverviewAnswer(
  question: string,
  results: SearchHit[],
): string {
  if (!results.length) {
    return "现有资料没有提供相关信息，因此无法根据资料确认。";
  }
  const lines = results.map((item, index) => {
    const label = item.section ?? item.chapter ?? `资料 ${index + 1}`;
    const excerpt = item.content
      .split(/(?<=[。！？!?])|\n+/u)
      .map((sentence) => sentence.trim())
      .filter(Boolean)
      .slice(0, 2)
      .join(" ")
      .slice(0, 260);
    return `- ${label}：${excerpt} [${index + 1}]`;
  });
  return [`围绕“${question.trim()}”，可按章节确认以下内容：`, ...lines].join("\n");
}

export function answerCitationsValid(
  answer: string,
  evidenceCount: number,
  overview = false,
): boolean {
  if (evidenceCount <= 0) return false;
  const references = [...answer.matchAll(/\[(\d+)\]/gu)].map((match) =>
    Number(match[1]),
  );
  if (
    !references.length ||
    references.some((reference) => reference < 1 || reference > evidenceCount)
  ) {
    return false;
  }
  if (!overview) return true;
  const substantiveLines = answer
    .split(/\n+/u)
    .map((line) => line.trim())
    .filter(
      (line) =>
        line.length >= 8 &&
        !/^#{1,6}\s/u.test(line) &&
        !/^(?:以下|根据|现有资料)/u.test(line),
    );
  return substantiveLines.every((line) => /\[\d+\]/u.test(line));
}

export function remapCitationReferences(
  answer: string,
  evidenceCount: number,
): { answer: string; evidenceIndexes: number[] } | undefined {
  const references = [...answer.matchAll(/\[(\d+)\]/gu)].map((match) => Number(match[1]));
  if (
    !references.length ||
    references.some((reference) => reference < 1 || reference > evidenceCount)
  ) {
    return undefined;
  }
  const ordered = [...new Set(references)];
  const remapped = new Map(ordered.map((reference, index) => [reference, index + 1]));
  return {
    answer: answer.replace(/\[(\d+)\]/gu, (_match, value: string) =>
      `[${remapped.get(Number(value))}]`),
    evidenceIndexes: ordered.map((reference) => reference - 1),
  };
}

export function toCitations(results: SearchHit[]): Citation[] {
  return results.map((item) => ({
    document_id: item.document_id,
    title: item.title,
    content: item.content.slice(0, 320),
    score: item.score,
    chunk_id: item.chunk_id,
    chunk_index: item.chunk_index,
    page_start: item.page_start,
    page_end: item.page_end,
    chapter: item.chapter,
    section: item.section,
  }));
}
