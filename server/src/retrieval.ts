import { tagsFromJson } from "./core.js";
import { getDb } from "./db.js";
import {
  cosineSimilarity,
  embedTexts,
  embeddingModelEnabled,
} from "./embeddings.js";
import { queryTerms, selectAnswerContexts } from "./search.js";
import {
  accessibleDocumentWhere,
  canAccessKnowledgeBase,
  searchChunks,
} from "./services.js";
import type {
  ConversationIntent,
  ConversationRetrievalState,
  QueryType,
  RetrievalScope,
  SearchHit,
  User,
} from "./types.js";

export interface RetrievalHistoryMessage {
  role: "user" | "assistant";
  content: string;
  citations?: Array<{ document_id?: number }>;
}

export interface RetrievalResult {
  intent: Exclude<ConversationIntent, "refinement">;
  queryType: QueryType;
  retrievalScope: RetrievalScope;
  retrievalQuery: string;
  scopeDocumentIds: number[];
  scopeSource: "query" | "history" | "dominant" | "knowledge_base" | "none";
  engine: "lexical" | "hybrid-vector-lexical";
  candidates: SearchHit[];
  contexts: SearchHit[];
}

export interface RetrievalOptions {
  intent?: Exclude<ConversationIntent, "refinement">;
  inheritedState?: ConversationRetrievalState;
}

export function intentRequiresRetrieval(intent: ConversationIntent): boolean {
  return intent !== "refinement";
}

export async function retrieveForConversationIntent<T>(
  intent: ConversationIntent,
  retrieve: () => Promise<T>,
): Promise<T | undefined> {
  return intentRequiresRetrieval(intent) ? retrieve() : undefined;
}

const overviewPatterns = [
  /有哪些(?:知识点|内容|重点|章节)/u,
  /(?:每|各)章/u,
  /目录/u,
  /(?:整本书|全书|整体|全局|总体)(?:内容|知识点|总结|概览|框架)?/u,
  /全部(?:内容|知识点|章节)/u,
  /第[0-9一二三四五六七八九十百]+章(?:讲什么|有哪些(?:内容|知识点|重点)|内容|概览|总结)/u,
  /^(?:请)?(?:给出|介绍|总结|概括|说明)?第[0-9一二三四五六七八九十百]+章(?:的)?(?:内容)?[？?]?$/u,
  /第[0-9一二三四五六七八九十百]+章(?:的)?(?:总结)?(?:知识点|重点|概览|框架)/u,
  /(?:总结|概括|梳理).{0,30}第[0-9一二三四五六七八九十百]+章/u,
  /(?:概览|梳理).{0,12}(?:文档|资料|章节)/u,
  /主要章节/u,
];

const contextualPatterns = [
  /^(?:每章|各章|这一章|本章|该章)/u,
  /^(?:还有|继续|展开|详细|补充|这些|上述|这本书|它)/u,
  /有哪些(?:重点|知识点)/u,
  /^第[0-9一二三四五六七八九十百]+章/u,
  /^(?:请)?(?:给出|介绍|总结|概括|说明)第[0-9一二三四五六七八九十百]+章/u,
  /^(?:第)?[0-9一二三四五六七八九十]+(?:点|条|项)/u,
  /^(?:哪些|哪几个).*(?:最重要|重点|常考)/u,
];

const refinementPatterns = [
  /^(?:请)?(?:再)?(?:更)?(?:精简|简短|简洁|详细|具体|通俗)(?:一?些|一点|点|说明|解释)?[。！!？?]?$/u,
  /^(?:请)?(?:再)?(?:把|将)?(?:上(?:一|条|面)(?:个)?(?:回答|答案|内容)?)?(?:精简|简化|缩短|压缩)(?:到|成|为)?(?:一|二|两|三|四|五|六|七|八|九|十|\d+)(?:行|句|句话|点|条|字)(?:以内)?[。！!？?]?$/u,
  /^(?:请)?(?:用)?(?:一|二|两|三|四|五|六|七|八|九|十|\d+)(?:行|句|句话|点|条)(?:概括|总结|回答|说明|表达)(?:一下)?[。！!？?]?$/u,
  /^(?:请)?(?:换种说法|换个说法|重新组织|重新表述|改写)(?:一下)?[。！!？?]?$/u,
  /^(?:请)?(?:用|改成)(?:表格|列表|要点|大白话)(?:表示|呈现|说明)?[。！!？?]?$/u,
  /^(?:请)?(?:只列|只保留|只留)(?:考研)?(?:重点|要点|结论)[。！!？?]?$/u,
  /^(?:请)?不要(?:举例|展开|解释原因)[。！!？?]?$/u,
];

const documentInventoryNounPattern = /(?:文档|资料|文件)/u;
const documentInventoryCuePattern = /(?:有什么|有哪些|多少(?:个|份)?|几(?:个|份)|提供|给出|列出|显示|查看|只要|只需|只列|名称|名字|标题|题目|清单|列表)/u;
const documentContentCuePattern = /(?:内容|正文|知识点|总结|概括|介绍|解释|分析|讲了什么|章节|原文|(?:哪|多少)[0-9一二三四五六七八九十百几]*(?:类|种)(?:文档|资料|文件))/u;

const subjectAliases = new Map<string, string[]>([
  ["计算机网络", ["计算机网络", "计网"]],
  ["计算机组成原理", ["计算机组成原理", "计组"]],
  ["操作系统", ["操作系统"]],
  ["数据结构", ["数据结构"]],
]);

const queryNoise = [
  "请",
  "帮我",
  "一下",
  "是什么",
  "有哪些",
  "知识点",
  "重点",
  "讲什么",
  "分别",
  "多少",
  "如何",
  "怎么",
  "为什么",
  "的",
  "呢",
  "吗",
];

export function classifyQuery(query: string): QueryType {
  const compact = query.replace(/\s+/gu, "");
  return overviewPatterns.some((pattern) => pattern.test(compact))
    ? "overview"
    : "local";
}

const scopePrototypes: Record<RetrievalScope, string> = {
  document_overview: "概括整本文档的主题、章节结构、全部主要知识点和整体框架",
  chapter_overview: "总结指定章节讲了什么，覆盖本章各个主要小节和知识点",
  local: "解释一个具体概念、原理、协议、算法、定义、步骤或机制",
};
let cachedScopePrototypeVectors: number[][] | undefined;

function explicitScope(query: string): RetrievalScope | undefined {
  const compact = query.replace(/\s+/gu, "");
  if (ordinalValue(compact)) return "local";
  if (requestedChapter(compact) && overviewPatterns.some((pattern) => pattern.test(compact))) {
    return "chapter_overview";
  }
  if (overviewPatterns.some((pattern) => pattern.test(compact))) {
    return "document_overview";
  }
  if (/(?:是什么|什么是|如何|怎么|为什么|原理|过程|步骤|区别|比较|作用)/u.test(compact)) {
    return "local";
  }
  return undefined;
}

export async function classifyRetrievalScope(
  query: string,
  embedder: (inputs: string[]) => Promise<number[][]> = embedTexts,
): Promise<RetrievalScope> {
  const explicit = explicitScope(query);
  if (explicit) return explicit;
  if (!embeddingModelEnabled() && embedder === embedTexts) return "local";
  try {
    const prototypeVectors = embedder === embedTexts
      ? cachedScopePrototypeVectors ?? await embedder(Object.values(scopePrototypes))
      : await embedder(Object.values(scopePrototypes));
    if (embedder === embedTexts) cachedScopePrototypeVectors = prototypeVectors;
    const [queryVector] = await embedder([query]);
    if (!queryVector || prototypeVectors.length !== 3) return "local";
    const scopes = Object.keys(scopePrototypes) as RetrievalScope[];
    const ranked = scopes.map((scope, index) => ({
      scope,
      score: cosineSimilarity(queryVector, prototypeVectors[index]!),
    })).sort((left, right) => right.score - left.score);
    const best = ranked[0];
    const second = ranked[1];
    if (best && best.score >= 0.45 && (!second || best.score - second.score >= 0.025)) {
      if (best.scope === "chapter_overview" && !requestedChapter(query)) {
        return "document_overview";
      }
      return best.scope;
    }
  } catch (error) {
    console.warn(
      "Retrieval scope embedding classification failed; using conservative local fallback:",
      error instanceof Error ? error.message : error,
    );
  }
  return "local";
}

export function classifyConversationIntent(
  query: string,
  hasPreviousAssistant = false,
): ConversationIntent {
  const compact = query.trim().replace(/\s+/gu, "");
  if (hasPreviousAssistant) {
    if (refinementPatterns.some((pattern) => pattern.test(compact))) {
      return "refinement";
    }
    if (isContextualRetrievalQuery(compact) || /^(?:这一章|本章|该章)/u.test(compact)) {
      return "contextual_query";
    }
  }
  return classifyQuery(compact) === "overview" ? "overview" : "new_query";
}

export function isDocumentInventoryQuery(query: string): boolean {
  const compact = query.trim().replace(/\s+/gu, "");
  return (
    documentInventoryNounPattern.test(compact) &&
    documentInventoryCuePattern.test(compact) &&
    !documentContentCuePattern.test(compact)
  );
}

export function isContextualRetrievalQuery(query: string): boolean {
  const compact = query.trim().replace(/\s+/gu, "");
  return contextualPatterns.some((pattern) => pattern.test(compact));
}

function normalized(value: string): string {
  return value
    .toLowerCase()
    .replace(/计组/gu, "计算机组成原理")
    .replace(/计网/gu, "计算机网络")
    .replace(/[\s_()（）【】\[\]·.,，。:：-]+/gu, "");
}

function coreDocumentTitle(title: string): string {
  return normalized(title)
    .replace(/(?:19|20)\d{2}/gu, "")
    .replace(/王道|考研复习指导|高清带书签版?|压缩版|组编/gu, "")
    .replace(/\d+/gu, "");
}

async function accessibleDocuments(
  user: User,
  knowledgeBaseId?: number,
): Promise<Array<{ id: number; title: string; owner_id: number }>> {
  const access = accessibleDocumentWhere(user);
  const clauses = [access.sql];
  const parameters: Array<string | number> = [...access.params];
  let join = "";
  if (knowledgeBaseId) {
    await canAccessKnowledgeBase(knowledgeBaseId, user);
    join = "JOIN kb_documents kd ON kd.document_id=d.id";
    clauses.push("kd.knowledge_base_id=?");
    parameters.push(knowledgeBaseId);
  }
  const rows = await getDb()
    .prepare(
      `SELECT DISTINCT d.id,d.title,d.owner_id FROM documents d ${join}
       WHERE ${clauses.join(" AND ")} ORDER BY d.id`,
    )
    .all(...parameters);
  return rows.map((row) => ({
    id: Number(row.id),
    title: String(row.title),
    owner_id: Number(row.owner_id),
  }));
}

export function explicitlyMatchedDocuments(
  query: string,
  documents: Array<{ id: number; title: string; owner_id?: number }>,
  preferredOwnerId?: number,
): number[] {
  const queryText = normalized(query);
  const subjects = [...subjectAliases.entries()]
    .filter(([, aliases]) => aliases.some((alias) => queryText.includes(normalized(alias))))
    .map(([subject]) => subject);
  const matched = documents.filter((document) => {
    const title = normalized(document.title);
    if (subjects.some((subject) => title.includes(normalized(subject)))) return true;
    const core = coreDocumentTitle(document.title);
    return core.length >= 4 && queryText.includes(core);
  });
  const owned = preferredOwnerId
    ? matched.filter((document) => document.owner_id === preferredOwnerId)
    : [];
  return (owned.length ? owned : matched).map((document) => document.id);
}

export function latestCitationDocumentIds(history: RetrievalHistoryMessage[]): number[] {
  const assistant = [...history]
    .reverse()
    .find((message) => message.role === "assistant" && message.citations?.length);
  return [
    ...new Set(
      (assistant?.citations ?? [])
        .map((citation) => Number(citation.document_id))
        .filter((id) => Number.isInteger(id) && id > 0),
    ),
  ];
}

function ordinalValue(query: string): number | undefined {
  const value = query.match(/第?([0-9一二三四五六七八九十]+)(?:点|条|项)/u)?.[1];
  if (!value) return undefined;
  if (/^\d+$/u.test(value)) return Number(value);
  const values: Record<string, number> = {
    一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
  };
  return values[value];
}

function referencedAnswerPoint(
  query: string,
  history: RetrievalHistoryMessage[],
): string | undefined {
  const ordinal = ordinalValue(query);
  if (!ordinal) return undefined;
  for (const message of [...history].reverse()) {
    if (message.role !== "assistant") continue;
    const lines = message.content
      .split(/\n+/u)
      .map((line) => line.trim())
      .filter((line) => /^(?:[-*•]|\d+[.、)]|[一二三四五六七八九十]+[、.])/u.test(line));
    const point = lines[ordinal - 1];
    if (point) {
      return point.replace(
        /^(?:[-*•]\s*|\d+[.、)]\s*|[一二三四五六七八九十]+[、.]\s*)/u,
        "",
      );
    }
  }
  return undefined;
}

export function contextualQuery(
  query: string,
  history: RetrievalHistoryMessage[],
  inheritedState?: ConversationRetrievalState,
): string {
  if (!isContextualRetrievalQuery(query)) return query.trim();
  const previousQuestion = inheritedState?.originalQuery || [...history]
    .reverse()
    .find((message) => message.role === "user")
    ?.content.trim();
  if (!previousQuestion) return query.trim();
  const referencedPoint = referencedAnswerPoint(query, history);
  const currentChapter = query.match(/第[0-9一二三四五六七八九十百]+章/u)?.[0];
  if (currentChapter) {
    const withChapter = /第[0-9一二三四五六七八九十百]+章/u.test(previousQuestion)
      ? previousQuestion.replace(
          /第[0-9一二三四五六七八九十百]+章/u,
          currentChapter,
        )
      : `${previousQuestion} ${currentChapter}`;
    return `${withChapter}\n追问：${query.trim()}`;
  }
  return [previousQuestion, referencedPoint ? `上下文要点：${referencedPoint}` : "", `追问：${query.trim()}`]
    .filter(Boolean)
    .join("\n");
}

export function requestedChapter(query: string): string | undefined {
  const value = query.match(/第([0-9一二三四五六七八九十百]+)章/u)?.[1];
  if (!value) return undefined;
  if (/^\d+$/u.test(value)) return `第${value}章`;
  const digits: Record<string, number> = {
    一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
  };
  if (value in digits) return `第${digits[value]}章`;
  if (value === "十") return "第10章";
  const tens = value.match(/^([一二三四五六七八九])?十([一二三四五六七八九])?$/u);
  if (tens) {
    return `第${(tens[1] ? digits[tens[1]] : 1) * 10 + (tens[2] ? digits[tens[2]] : 0)}章`;
  }
  return `第${value}章`;
}

function coreTerms(query: string): string[] {
  let cleaned = normalized(query);
  for (const noise of queryNoise) cleaned = cleaned.replaceAll(normalized(noise), "");
  return queryTerms(cleaned).filter(
    (term) =>
      /^[a-z0-9_]{2,}$/iu.test(term) ||
      (/^[\p{Script=Han}]+$/u.test(term) && term.length >= 2),
  );
}

export function evidenceTermCoverage(query: string, hit: SearchHit): number {
  const terms = coreTerms(query);
  if (!terms.length) return 1;
  const haystack = normalized(`${hit.title} ${hit.chapter ?? ""} ${hit.section ?? ""} ${hit.content}`);
  const matched = terms.filter((term) => haystack.includes(normalized(term))).length;
  return matched / terms.length;
}

export function isSufficientlyRelevantEvidence(query: string, hit: SearchHit): boolean {
  const chapter = requestedChapter(query);
  if (chapter && hit.chapter === chapter) return true;
  const coverage = evidenceTermCoverage(query, hit);
  const latinTerms = coreTerms(query).filter((term) => /^[a-z0-9_]+$/iu.test(term));
  const latinMatched = latinTerms.some((term) =>
    normalized(`${hit.title} ${hit.content}`).includes(normalized(term)),
  );
  return coverage >= 0.42 || latinMatched || (hit.lexical_score ?? 0) >= 0.52 || hit.score >= 0.4;
}

function dominantDocument(hits: SearchHit[], query: string): number[] {
  const relevant = hits.filter((hit) => isSufficientlyRelevantEvidence(query, hit)).slice(0, 8);
  if (!relevant.length) return [];
  const groups = new Map<number, { count: number; score: number }>();
  for (const hit of relevant) {
    const group = groups.get(hit.document_id) ?? { count: 0, score: 0 };
    group.count += 1;
    group.score += hit.score;
    groups.set(hit.document_id, group);
  }
  const ordered = [...groups.entries()].sort(
    (left, right) =>
      right[1].count - left[1].count || right[1].score - left[1].score,
  );
  const first = ordered[0];
  const second = ordered[1];
  if (!first || first[1].count < 2) return [];
  if (second && first[1].count === second[1].count && first[1].score < second[1].score * 1.15) {
    return [];
  }
  return [first[0]];
}

function strongestDocument(hits: SearchHit[], candidates: number[]): number | undefined {
  const candidateSet = new Set(candidates);
  const groups = new Map<number, { count: number; score: number }>();
  for (const hit of hits) {
    if (!candidateSet.has(hit.document_id)) continue;
    const group = groups.get(hit.document_id) ?? { count: 0, score: 0 };
    group.count += 1;
    group.score += hit.score;
    groups.set(hit.document_id, group);
  }
  return [...groups.entries()].sort(
    (left, right) => right[1].count - left[1].count || right[1].score - left[1].score,
  )[0]?.[0] ?? candidates[0];
}

async function chapterContexts(
  user: User,
  documentIds: number[],
  knowledgeBaseId?: number,
  chapter?: string,
): Promise<SearchHit[]> {
  if (!documentIds.length) return [];
  const access = accessibleDocumentWhere(user);
  const clauses = [
    access.sql,
    `d.id IN (${documentIds.map(() => "?").join(",")})`,
    "c.chapter IS NOT NULL",
    "c.quality_score>=0.48",
  ];
  const parameters: Array<string | number> = [...access.params, ...documentIds];
  if (chapter) {
    clauses.push("c.chapter=?");
    parameters.push(chapter);
  }
  let join = "";
  if (knowledgeBaseId) {
    join = "JOIN kb_documents kd ON kd.document_id=d.id";
    clauses.push("kd.knowledge_base_id=?");
    parameters.push(knowledgeBaseId);
  }
  const rows = await getDb()
    .prepare(
      `SELECT c.id AS chunk_id,c.chunk_index,c.content,c.page_start,c.page_end,
        c.chapter,c.section,c.content_type,c.quality_score,
        d.id AS document_id,d.title,d.category,d.tags
       FROM document_chunks c JOIN documents d ON d.id=c.document_id
       ${join} WHERE ${clauses.join(" AND ")}
       ORDER BY d.id,c.chunk_index LIMIT 4000`,
    )
    .all(...parameters);
  const hits = rows.map((row): SearchHit => ({
    chunk_id: Number(row.chunk_id),
    chunk_index: Number(row.chunk_index),
    document_id: Number(row.document_id),
    title: String(row.title),
    category: String(row.category),
    tags: tagsFromJson(row.tags),
    content: String(row.content),
    score: Number(row.quality_score ?? 1),
    page_start: row.page_start === null ? null : Number(row.page_start),
    page_end: row.page_end === null ? null : Number(row.page_end),
    chapter: row.chapter ? String(row.chapter) : null,
    section: row.section ? String(row.section) : null,
    content_type: String(row.content_type ?? "content") as SearchHit["content_type"],
    quality_score: Number(row.quality_score ?? 1),
  }));
  return selectChapterRepresentativeContexts(hits);
}

export function selectChapterRepresentativeContexts(hits: SearchHit[]): SearchHit[] {
  const chapterGroups = new Map<string, SearchHit[]>();
  for (const hit of hits) {
    if (!hit.chapter) continue;
    const key = `${hit.document_id}:${hit.chapter}`;
    const group = chapterGroups.get(key) ?? [];
    group.push(hit);
    chapterGroups.set(key, group);
  }
  const groups = [...chapterGroups.values()]
    .sort((left, right) => {
      const leftChapter = Number(left[0]?.chapter?.match(/第(\d+)章/u)?.[1] ?? 999);
      const rightChapter = Number(right[0]?.chapter?.match(/第(\d+)章/u)?.[1] ?? 999);
      return leftChapter - rightChapter;
    })
    .slice(0, 24);
  const representativeRank = (hit: SearchHit): number => {
    const compact = hit.content.replace(/\s/gu, "");
    const letters = compact.match(/[\p{L}\p{N}]/gu)?.length ?? 0;
    const han = compact.match(/[\p{Script=Han}]/gu)?.length ?? 0;
    const hanRatio = letters ? han / letters : 0;
    const exercisePenalty = /(?:答案与解析|习题精选|模拟题)/u.test(
      `${hit.section ?? ""} ${hit.content}`,
    ) ? 2 : 0;
    const lengthScore = Math.min(1.2, compact.length / 500);
    return (
      (hit.content_type === "content" ? 3 : hit.content_type === "heading" ? 1 : 0) +
      (hit.section ? 0.8 : 0) +
      (hit.quality_score ?? 0) +
      hanRatio * 3 -
      exercisePenalty +
      lengthScore -
      (compact.length < 120 ? 1.5 : 0)
    );
  };
  const representativesByChapter = groups.map((group) => {
    const exerciseEvidence = /(?:本节习题|习题精选|答案与解析|模拟题|单项选择题)/u;
    const usable = group.filter(
      (hit) =>
        hit.content_type !== "toc" &&
        !exerciseEvidence.test(`${hit.section ?? ""} ${hit.content.slice(0, 120)}`),
    );
    const sectionGroups = new Map<string, SearchHit[]>();
    const hasSections = usable.some((hit) => Boolean(hit.section));
    for (const [index, hit] of usable.entries()) {
      const majorSection = hit.section?.match(/^(\d+\.\d+)/u)?.[1];
      const bucket = hasSections
        ? majorSection ?? hit.section ?? "__unsectioned"
        : `__position_${Math.min(3, Math.floor((index * 4) / Math.max(usable.length, 1)))}`;
      const section = sectionGroups.get(bucket) ?? [];
      section.push(hit);
      sectionGroups.set(bucket, section);
    }
    return [...sectionGroups.values()]
      .sort((left, right) => left[0]!.chunk_index - right[0]!.chunk_index)
      .map((section) => [...section].sort(
        (left, right) =>
          representativeRank(right) - representativeRank(left) ||
          left.chunk_index - right.chunk_index,
      )[0]!)
      .filter(Boolean);
  });
  const selected: SearchHit[] = [];
  if (representativesByChapter.length === 1) {
    return representativesByChapter[0]!.slice(0, 16);
  }
  for (let sectionIndex = 0; selected.length < 16; sectionIndex += 1) {
    let added = false;
    for (const chapter of representativesByChapter) {
      const representative = chapter[sectionIndex];
      if (!representative) continue;
      selected.push(representative);
      added = true;
      if (selected.length >= 16) break;
    }
    if (!added) break;
  }
  return selected;
}

export async function retrieveQuestionContexts(
  user: User,
  question: string,
  history: RetrievalHistoryMessage[] = [],
  knowledgeBaseId?: number,
  options: RetrievalOptions = {},
): Promise<RetrievalResult> {
  const classifiedIntent = options.intent ?? classifyConversationIntent(
    question,
    history.some((message) => message.role === "assistant"),
  );
  const intent = classifiedIntent === "refinement" ? "new_query" : classifiedIntent;
  const inheritedState = options.inheritedState;
  const contextual = intent === "contextual_query";
  const retrievalQuery = contextualQuery(question, history, inheritedState);
  const retrievalScope = ordinalValue(question)
    ? "local"
    : await classifyRetrievalScope(retrievalQuery);
  const queryType: QueryType = retrievalScope === "local" ? "local" : "overview";
  const documents = await accessibleDocuments(user, knowledgeBaseId);
  const explicitDocumentIds = explicitlyMatchedDocuments(question, documents, user.id);
  const inheritedDocumentIds = contextual
    ? (inheritedState?.documentIds.length
      ? inheritedState.documentIds
      : latestCitationDocumentIds(history)).filter((id) =>
        documents.some((document) => document.id === id),
      )
    : [];
  let scopeDocumentIds = explicitDocumentIds.length
    ? explicitDocumentIds
    : inheritedDocumentIds;
  let scopeSource: RetrievalResult["scopeSource"] = explicitDocumentIds.length
    ? "query"
    : inheritedDocumentIds.length
      ? "history"
      : knowledgeBaseId
        ? "knowledge_base"
        : "none";
  const chapter = requestedChapter(question) ?? (contextual
    ? inheritedState?.chapter ?? undefined
    : undefined);
  let searchResult = await searchChunks(user, retrievalQuery, {
    knowledgeBaseId,
    documentIds: scopeDocumentIds,
    chapter,
    limit: queryType === "overview" ? 120 : 20,
  });

  if (!scopeDocumentIds.length) {
    const dominant = dominantDocument(searchResult.hits, question);
    if (!dominant.length && queryType === "overview" && searchResult.hits[0]) {
      dominant.push(searchResult.hits[0].document_id);
    }
    if (dominant.length) {
      scopeDocumentIds = dominant;
      scopeSource = "dominant";
      searchResult = await searchChunks(user, retrievalQuery, {
        knowledgeBaseId,
        documentIds: dominant,
        chapter,
        limit: 20,
      });
    }
  }

  if (queryType === "overview" && scopeDocumentIds.length > 1) {
    const strongest = strongestDocument(searchResult.hits, scopeDocumentIds);
    if (strongest) {
      scopeDocumentIds = [strongest];
      searchResult = await searchChunks(user, retrievalQuery, {
        knowledgeBaseId,
        documentIds: scopeDocumentIds,
        chapter,
        limit: 120,
      });
    }
  }

  let contexts: SearchHit[];
  if (retrievalScope !== "local" && scopeDocumentIds.length) {
    contexts = await chapterContexts(
      user,
      scopeDocumentIds,
      knowledgeBaseId,
      retrievalScope === "chapter_overview" ? chapter : undefined,
    );
    if (!contexts.length) contexts = searchResult.hits.slice(0, 20);
  } else {
    const relevantHits = searchResult.hits.filter(
      (hit) =>
        hit.content_type !== "toc" &&
        isSufficientlyRelevantEvidence(question, hit),
    );
    contexts = selectAnswerContexts(retrievalQuery, relevantHits, 5);
  }

  return {
    intent,
    queryType,
    retrievalScope,
    retrievalQuery,
    scopeDocumentIds,
    scopeSource,
    engine: searchResult.engine,
    candidates: searchResult.hits,
    contexts,
  };
}
