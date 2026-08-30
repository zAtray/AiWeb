import { tagsFromJson } from "./core.js";
import { getDb } from "./db.js";
import {
  cosineSimilarity,
  embedTexts,
  embeddingGeneration,
  embeddingModelEnabled,
  embeddingModelName,
} from "./embeddings.js";
import { dedupeTopK, retrievalOutcome as classifyRetrievalOutcome } from "./rag-pipeline.js";
import {
  queryTerms,
  sanitizeEvidenceContent,
  selectAnswerContexts,
} from "./search.js";
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
  intent: Exclude<ConversationIntent, "refinement" | "summarize_previous">;
  queryType: QueryType;
  retrievalScope: RetrievalScope;
  retrievalQuery: string;
  scopeDocumentIds: number[];
  scopeSource: "query" | "history" | "dominant" | "knowledge_base" | "none";
  engine: "lexical" | "hybrid-vector-lexical";
  candidates: SearchHit[];
  contexts: SearchHit[];
  originalQuery: string;
  rewriteApplied: boolean;
  rewriteReason: string;
  resolvedEntities: string[];
  retrievalOutcome: "sufficient" | "retrieval_insufficient";
}

export interface RetrievalOptions {
  intent?: Exclude<ConversationIntent, "refinement" | "summarize_previous">;
  inheritedState?: ConversationRetrievalState;
}

export function intentRequiresRetrieval(intent: ConversationIntent): boolean {
  return intent !== "refinement" && intent !== "summarize_previous";
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
  /(?:这|该|本)(?:本|份)?(?:书|文档|资料).{0,12}(?:主要)?(?:讲什么|讲了什么|内容|知识点|概览|总结|框架)/u,
  /(?:总结|概括|梳理).{0,30}(?:两|二|2|全部|所有|各)(?:份)?(?:文档|资料|文件)/u,
];

const contextualPatterns = [
  /^(?:每章|各章|这一章|本章|该章)/u,
  /^(?:还有|继续|展开|详细|补充|这些|上述|这本书|它)/u,
  /有哪些(?:重点|知识点)/u,
  /^第[0-9一二三四五六七八九十百]+章/u,
  /^(?:请)?(?:给出|介绍|总结|概括|说明)第[0-9一二三四五六七八九十百]+章/u,
  /^(?:第)?[0-9一二三四五六七八九十]+(?:点|条|项)/u,
  /^(?:哪些|哪几个).*(?:最重要|重点|常考)/u,
  /^(?:请)?(?:给出|回答|说明)?(?:一个|一份)?(?:更|再)?(?:详细|具体|全面)(?:一些|一点)?(?:的)?(?:回答|答案|说明|解释)?[。！!？?]?$/u,
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

const summarizePreviousPatterns = [
  /^(?:请)?(?:给出|做(?:一个|个)?|来(?:一个|个)?)?(?:对)?(?:刚才|刚刚|上述|上面|前面|上一轮|上一条|那些|这些)?(?:的|内容)?(?:总结|小结|概括|归纳)(?:一下)?[。！!？?]?$/u,
  /^(?:请)?(?:把|将)?(?:刚才|刚刚|上述|上面|前面|上一轮|上一条)(?:的)?(?:那些|这些)?内容(?:总结|小结|概括|归纳)(?:一下)?[。！!？?]?$/u,
  /^(?:请)?(?:总结|小结|概括|归纳)(?:一下)?(?:刚才|刚刚|上述|上面|前面|上一轮|上一条)(?:的)?(?:那些|这些)?内容[。！!？?]?$/u,
];

const explainPreviousPatterns = [
  /^(?:请)?(?:再)?(?:更)?(?:详细|具体|通俗)(?:一?些|一点|点)?(?:说明|解释|说说|讲讲)?[。！!？?]?$/u,
  /^(?:第)?[0-9一二三四五六七八九十]+(?:个|点|条|项)(?:呢)?(?:再)?(?:详细|具体)?(?:说说|讲讲|解释|说明)?[。！!？?]?$/u,
  /^(?:这|这个|该内容|它)(?:是)?什么意思[。！!？?]?$/u,
  /^为什么(?:呢)?[。！!？?]?$/u,
];

const continuePreviousPatterns = [
  /^(?:请)?(?:继续|接着(?:说|讲)?|往下(?:说|讲)?|还有呢|然后呢)(?:一下)?[。！!？?]?$/u,
];

const followUpPatterns = [
  /^(?:那|那么)?(?:这|这个|这些|那些|它|它们|他们|她们|其|上述内容)/u,
  /^(?:有什么区别|区别是什么|作用是什么|缺点是什么|优点是什么)[。！!？?]?$/u,
];

const documentInventoryNounPattern = /(?:文档|资料|文件)/u;
const documentInventoryCuePattern = /(?:有什么|有哪些|多少(?:个|份)?|几(?:个|份)|提供|给出|列出|显示|查看|只要|只需|只列|名称|名字|标题|题目|清单|列表)/u;
const documentContentCuePattern = /(?:内容|正文|知识点|总结|概括|介绍|解释|分析|讲了什么|章节|原文|(?:哪|多少)[0-9一二三四五六七八九十百几]*(?:类|种)(?:文档|资料|文件))/u;
const knowledgeBaseInventoryCuePattern = /(?:有什么|有哪些|多少(?:个)?|几(?:个)?|提供|给出|列出|显示|查看|名称|名字|清单|列表)/u;

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
let cachedScopePrototypeVectors: { key: string; vectors: number[][] } | undefined;

function explicitScope(query: string): RetrievalScope | undefined {
  const compact = query.replace(/\s+/gu, "");
  if (ordinalValue(compact)) return "local";
  if (/(?:有没有|是否)(?:说明|提到|包含|涉及)|资料中(?:有|是否)/u.test(compact)) {
    return "local";
  }
  if (requestedChapter(compact) && overviewPatterns.some((pattern) => pattern.test(compact))) {
    return "chapter_overview";
  }
  if (overviewPatterns.some((pattern) => pattern.test(compact))) {
    return "document_overview";
  }
  // “有哪些用户角色/支持格式/权限”等是在列举一个具体事实集合，
  // 不能交给向量原型误判成整篇文档概览。
  if (/(?:有哪些|有什么|多少(?:个|项|种)?|哪(?:些|几)(?:个|项|种)?)/u.test(compact)) {
    return "local";
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
    const prototypeKey = `${embeddingModelName()}:${embeddingGeneration()}`;
    const prototypeVectors = embedder === embedTexts
      ? cachedScopePrototypeVectors?.key === prototypeKey
        ? cachedScopePrototypeVectors.vectors
        : await embedder(Object.values(scopePrototypes))
      : await embedder(Object.values(scopePrototypes));
    if (embedder === embedTexts) cachedScopePrototypeVectors = { key: prototypeKey, vectors: prototypeVectors };
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
    if (summarizePreviousPatterns.some((pattern) => pattern.test(compact))) {
      return "summarize_previous";
    }
    if (continuePreviousPatterns.some((pattern) => pattern.test(compact))) {
      return "continue_previous";
    }
    if (explainPreviousPatterns.some((pattern) => pattern.test(compact))) {
      return "explain_previous";
    }
    if (refinementPatterns.some((pattern) => pattern.test(compact))) {
      return "refinement";
    }
    if (followUpPatterns.some((pattern) => pattern.test(compact))) {
      return "follow_up";
    }
    if (isContextualRetrievalQuery(compact) || /^(?:这一章|本章|该章)/u.test(compact)) {
      return "contextual_query";
    }
  }
  return classifyQuery(compact) === "overview" ? "overview" : "new_query";
}

export function isDocumentInventoryQuery(query: string): boolean {
  const compact = query.trim().replace(/\s+/gu, "");
  if (!documentInventoryNounPattern.test(compact) || documentContentCuePattern.test(compact)) {
    return false;
  }
  return [
    /(?:列出|显示|查看|给出)(?:当前|这个|该)?(?:知识库(?:中|里|内)?的?)?(?:全部|所有)?(?:文档|资料|文件)(?:清单|列表|名称|标题)?/u,
    /(?:当前|这个|该)?知识库(?:中|里|内)?(?:有|共有|包含)(?:哪些|多少(?:个|份)?|几(?:个|份)?)(?:文档|资料|文件)/u,
    /(?:当前|这个|该)?知识库(?:中|里|内)?(?:的)?(?:全部|所有)?(?:文档|资料|文件)(?:清单|列表)/u,
    /(?:文档|资料|文件)(?:清单|列表)/u,
  ].some((pattern) => pattern.test(compact));
}

export function isKnowledgeBaseInventoryQuery(query: string): boolean {
  const compact = query.trim().replace(/\s+/gu, "");
  return (
    /知识库/u.test(compact) &&
    !documentInventoryNounPattern.test(compact) &&
    !isKnowledgeBaseProfileQuery(compact) &&
    (
      knowledgeBaseInventoryCuePattern.test(compact) ||
      /(?:告诉我|介绍)(?:一下)?(?:当前|现有|全部|所有)?知识库(?:的)?内容/u.test(compact) ||
      /知识库(?:的)?内容/u.test(compact)
    )
  );
}

export function isKnowledgeBaseProfileQuery(query: string): boolean {
  const compact = query.trim().replace(/\s+/gu, "");
  return (
    /知识库/u.test(compact) &&
    /(?:简介|介绍|概况|概览)/u.test(compact) &&
    !/(?:有哪些|有什么|多少(?:个)?|列表|清单)/u.test(compact)
  );
}

export function requestsMultipleDocumentOverview(query: string): boolean {
  const compact = query.trim().replace(/\s+/gu, "");
  return (
    /(?:两|二|2|全部|所有|各)(?:份)?(?:文档|资料|文件)/u.test(compact) ||
    /(?:文档|资料|文件)(?:分别|各自)/u.test(compact)
  );
}

export function requestsKnowledgeBaseContents(query: string): boolean {
  const compact = query.trim().replace(/\s+/gu, "");
  return /知识库(?:的)?内容/u.test(compact);
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
  const intent = classifyConversationIntent(query, history.some((message) => message.role === "assistant"));
  const contextualIntents: ConversationIntent[] = [
    "contextual_query",
    "follow_up",
    "explain_previous",
    "continue_previous",
  ];
  if (!contextualIntents.includes(intent)) return query.trim();
  const previousQuestion = inheritedState?.originalQuery || [...history]
    .reverse()
    .find((message) => message.role === "user")
    ?.content.trim();
  if (!previousQuestion) return query.trim();
  const referencedPoint = referencedAnswerPoint(query, history);
  const subject = previousQuestion
    .replace(/^(?:请问|请|帮我|介绍(?:一下)?|讲解(?:一下)?)/u, "")
    .replace(/(?:是什么|指什么|讲了什么|讲什么|有哪些(?:内容|知识点|重点)|怎么样|如何)[。！!？?]?$/u, "")
    .trim();
  const compact = query.trim().replace(/\s+/gu, "");
  if (referencedPoint) {
    return `请围绕以下上一轮要点继续回答“${query.trim()}”：${referencedPoint}`;
  }
  if (intent === "explain_previous") {
    return `请更详细地解释${subject || previousQuestion}`;
  }
  if (intent === "continue_previous") {
    return `请继续介绍${subject || previousQuestion}尚未展开的相关内容`;
  }
  if (/^(?:那|那么)?(?:这些|这个|这|它们|它|他们|她们|其)/u.test(compact)) {
    const resolved = compact.replace(/^(?:那|那么)?(?:这些|这个|这|它们|它|他们|她们|其)/u, subject || previousQuestion);
    return resolved;
  }
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

export function rewriteRetrievalQuery(
  query: string,
  history: RetrievalHistoryMessage[],
  inheritedState?: ConversationRetrievalState,
): { query: string; applied: boolean; reason: string; entities: string[] } {
  const rewritten = contextualQuery(query, history, inheritedState);
  const required = [
    ...(query.match(/\b\d+(?:\.\d+)?\b/gu) ?? []),
    ...(query.match(/(?:不|没有|禁止|不得|区别|比较)/gu) ?? []),
  ];
  if (required.some((term) => !rewritten.includes(term))) {
    return { query: query.trim(), applied: false, reason: "drift_guard", entities: [] };
  }
  const originalTerms = new Set(queryTerms(query));
  const entities = queryTerms(rewritten)
    .filter((term) => term.length >= 2 && !originalTerms.has(term))
    .slice(0, 8);
  return {
    query: rewritten,
    applied: rewritten.trim() !== query.trim(),
    reason: rewritten.trim() !== query.trim() ? "conversation_coreference" : "not_needed",
    entities,
  };
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

const deixisPrefixPattern = /^(?:这|那|该|本|当前|以上|上述|刚才|前面)(?:份|个|本)?(?:资料|文档|文件|书|书籍|内容|文本|章节|段落|篇)?的?/u;

function stripDeixisPrefix(value: string): string {
  return value.replace(deixisPrefixPattern, "");
}

export function evidenceTermCoverage(query: string, hit: SearchHit): number {
  const stripped = stripDeixisPrefix(query.trim());
  const terms = coreTerms(stripped);
  if (!terms.length) return 1;
  const haystack = normalized(`${hit.title} ${hit.chapter ?? ""} ${hit.section ?? ""} ${hit.content}`);
  const matched = terms.filter((term) => haystack.includes(normalized(term))).length;
  return matched / terms.length;
}

function definitionSubject(query: string): string | undefined {
  const compact = query.trim().replace(/\s+/gu, "").replace(/^(?:请问|请|帮我解释一下)/u, "");
  const leading = compact.match(/^什么是(.+?)[？?]?$/u)?.[1];
  const trailing = compact.match(/^(.+?)(?:是什么|指什么|的定义是什么|的定义)[？?]?$/u)?.[1];
  let subject = normalized(leading ?? trailing ?? "");
  // 剥离开头的指示/话题前缀（如"这份资料的文档代号"→"文档代号"），
  // 这些前缀指代文档本身而非被问的概念，会导致在正文中找不到完整匹配。
  subject = stripDeixisPrefix(subject);
  // 多事实主语（含列表分隔符）不是单一概念定义，返回 undefined 让
  // evidenceTermCoverage 用整体覆盖率判断相关性。
  if (
    /(?:、|，|,|；|;|和|及|与|或)/u.test(subject) ||
    /(?:什么|多少|哪些|哪里|何处|如何|怎么)/u.test(subject)
  ) return undefined;
  return subject.length >= 2 ? subject : undefined;
}

const definitionalContinuation = /^(?:是|指|定义为|称为|表示|用于|负责|通过|根据|包括|包含|具有|拥有|保证|提供|确保|控制|由|依次|过程|为|已经|正在|会|可以|可|需要|需|必须|使用|通常|时|将|用来|能够)/u;

function contentDefinesSubject(query: string, hit: SearchHit): boolean {
  const subject = definitionSubject(query);
  if (!subject) return true;
  const content = normalized(hit.content);
  const relationalSubject = subject.match(
    /^(.+?)(?:的)?(?:目的|作用|原因|意义|方式|要求|能力|功能)$/u,
  )?.[1];
  // Purpose/effect questions ask about a relation rather than the definition
  // of the whole phrase (for example “文档所有权隔离的目的是什么”). An exact
  // occurrence of the governed concept is grounded evidence for retrieval;
  // the answer layer still has to cite that evidence and may decline to infer.
  if (relationalSubject && content.includes(relationalSubject)) return true;
  // “数据库索引中的事务”这类表述把概念藏在 的/中 之后，正文只含末尾的概念；
  // “Git 提交信息”这类主语带拉丁前缀，正文通常只写概念本身；拆出片段一起匹配。
  const candidates = [subject];
  if (subject.includes("的")) candidates.push(subject.slice(subject.lastIndexOf("的") + 1));
  const latinPrefix = subject.match(/^[a-z0-9_]+/u)?.[0];
  if (latinPrefix && latinPrefix.length < subject.length) {
    candidates.push(subject.slice(latinPrefix.length));
  }
  for (const candidate of [...new Set(candidates)].filter((value) => value.length >= 2)) {
    if (!content.includes(candidate)) continue;
    // Codes and identifiers are often formatted as list items rather than
    // followed by “是/指”; an exact occurrence is sufficient grounding.
    if (/[a-z0-9_]/iu.test(candidate)) return true;
    // Chunks may embed the 《title》 line before the body, so the first
    // occurrence can sit inside the title; scan every occurrence and accept
    // when any of them reads like a definition.
    let position = content.indexOf(candidate);
    while (position >= 0) {
      const continuation = content.slice(position + candidate.length, position + candidate.length + 50);
      if (definitionalContinuation.test(continuation)) return true;
      position = content.indexOf(candidate, position + candidate.length);
    }
  }
  return false;
}

export function isSufficientlyRelevantEvidence(query: string, hit: SearchHit): boolean {
  if (!contentDefinesSubject(query, hit)) return false;
  const chapter = requestedChapter(query);
  if (chapter && hit.chapter === chapter) return true;
  const coverage = evidenceTermCoverage(query, hit);
  const latinTerms = coreTerms(query).filter((term) => /^[a-z0-9_]+$/iu.test(term));
  const latinMatched = latinTerms.some((term) =>
    normalized(`${hit.title} ${hit.content}`).includes(normalized(term)),
  );
  const channelAgreement = [
    hit.content_rank,
    hit.metadata_rank,
    hit.exact_rank,
    hit.vector_rank,
  ].filter(Boolean).length >= 2;
  return (
    coverage >= 0.3 ||
    latinMatched ||
    (coverage > 0 && (hit.lexical_score ?? 0) >= 0.18) ||
    (coverage > 0 && channelAgreement)
  );
}

export function multiFactQueries(query: string): string[] {
  const compact = query.trim().replace(/\s+/gu, "");
  const explicitlySeparated = /(?:分别|各自)/u.test(compact);
  const summarySubject = compact.match(
    /(?:总结|概括|归纳)(.+?)(?:[。！!？?]|$)/u,
  )?.[1];
  if (!explicitlySeparated && !summarySubject) return [query.trim()];
  const subjectList = summarySubject ?? compact.split(/(?:分别|各自)/u, 1)[0] ?? "";
  const subjects = subjectList
    .split(/[、，,和及与]/u)
    .map((subject) => subject.replace(/^(?:请问|请|查询)/u, "").trim())
    .filter((subject) => subject.length >= 2);
  if (subjects.length < 2 || subjects.length > 5) return [query.trim()];
  const sharedSuffix = subjects.at(-1)?.match(/(?:能力|功能|要求|机制|特点)$/u)?.[0] ?? "";
  const predicate = /(?:多少|几(?:个|项)?)/u.test(compact) ? "是多少" : "是什么";
  return [...new Set([
    query.trim(),
    ...subjects.map((subject) =>
      `${sharedSuffix && !subject.endsWith(sharedSuffix) ? `${subject}${sharedSuffix}` : subject}${predicate}`),
  ])];
}

async function searchConversationQueries(
  user: User,
  queries: string[],
  options: NonNullable<Parameters<typeof searchChunks>[2]>,
): Promise<Awaited<ReturnType<typeof searchChunks>>> {
  const results = await Promise.all(
    queries.map((query) => searchChunks(user, query, options)),
  );
  const merged = new Map<number, SearchHit>();
  for (const result of results) {
    for (const hit of result.hits) {
      const existing = merged.get(hit.chunk_id);
      if (!existing || hit.score > existing.score) merged.set(hit.chunk_id, hit);
    }
  }
  const seeded: SearchHit[] = [];
  const seededIds = new Set<number>();
  for (const [index, result] of results.entries()) {
    const query = queries[index]!;
    const seed = result.hits.find((hit) =>
      isSufficientlyRelevantEvidence(query, hit),
    );
    if (seed && !seededIds.has(seed.chunk_id)) {
      seeded.push(merged.get(seed.chunk_id) ?? seed);
      seededIds.add(seed.chunk_id);
    }
  }
  const remaining = [...merged.values()]
    .filter((hit) => !seededIds.has(hit.chunk_id))
    .sort((left, right) => right.score - left.score);
  return {
    engine: results.some((result) => result.engine === "hybrid-vector-lexical")
      ? "hybrid-vector-lexical"
      : "lexical",
    // Preserve one grounded result from each decomposed sub-query before
    // filling by global score. Otherwise one branch can consume the per-doc
    // cap and silently erase the other requested fact.
    hits: [...seeded, ...remaining]
      .slice(0, options.limit ?? 12),
  };
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
        c.document_version,c.chapter,c.section,c.content_type,c.quality_score,
        d.id AS document_id,d.title,d.filename,d.category,d.tags
       FROM document_chunks c JOIN documents d ON d.id=c.document_id
       ${join} WHERE d.status='ready' AND c.document_version=d.version
       AND ${clauses.join(" AND ")}
       ORDER BY d.id,c.chunk_index LIMIT 4000`,
    )
    .all(...parameters);
  const hits = rows.map((row): SearchHit => ({
    chunk_id: Number(row.chunk_id),
    chunk_index: Number(row.chunk_index),
    document_id: Number(row.document_id),
    document_version: Number(row.document_version),
    title: String(row.title),
    filename: String(row.filename),
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

function representativeRank(hit: SearchHit): number {
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
}

async function expandAdjacentContexts(user: User, anchors: SearchHit[]): Promise<SearchHit[]> {
  if (!anchors.length) return [];
  const access = accessibleDocumentWhere(user);
  const pairs = anchors.map(() => "(c.document_id=? AND c.chunk_index BETWEEN ? AND ?)");
  const pairParameters = anchors.flatMap((hit) => [
    hit.document_id,
    Math.max(0, hit.chunk_index - 1),
    hit.chunk_index + 1,
  ]);
  const rows = await getDb().prepare(
    `SELECT c.id AS chunk_id,c.chunk_index,c.document_version,c.content,c.page_start,c.page_end,
      c.chapter,c.section,c.content_type,c.quality_score,
      d.id AS document_id,d.title,d.filename,d.category,d.tags
     FROM document_chunks c JOIN documents d ON d.id=c.document_id
     WHERE d.status='ready' AND c.document_version=d.version AND ${access.sql}
       AND (${pairs.join(" OR ")})
     ORDER BY c.document_id,c.chunk_index`,
  ).all(...access.params, ...pairParameters);
  const anchorsByDocument = new Map<number, SearchHit[]>();
  for (const anchor of anchors) {
    const group = anchorsByDocument.get(anchor.document_id) ?? [];
    group.push(anchor);
    anchorsByDocument.set(anchor.document_id, group);
  }
  const expanded = rows.flatMap((row): SearchHit[] => {
    const documentId = Number(row.document_id);
    const chunkIndex = Number(row.chunk_index);
    const anchor = (anchorsByDocument.get(documentId) ?? []).find((item) =>
      Math.abs(item.chunk_index - chunkIndex) <= 1 &&
      item.document_version === Number(row.document_version) &&
      item.chapter === (row.chapter ? String(row.chapter) : null) &&
      (
        item.section === (row.section ? String(row.section) : null) ||
        (item.content_type === "heading" && item.section === null)
      ));
    if (!anchor) return [];
    return [{
      ...anchor,
      chunk_id: Number(row.chunk_id),
      chunk_index: chunkIndex,
      content: String(row.content),
      page_start: row.page_start === null ? null : Number(row.page_start),
      page_end: row.page_end === null ? null : Number(row.page_end),
      content_type: String(row.content_type ?? "content") as SearchHit["content_type"],
      quality_score: Number(row.quality_score ?? 1),
      source_chunk_ids: [Number(row.chunk_id)],
    }];
  });
  return [...new Map(expanded.map((hit) => [hit.chunk_id, hit])).values()];
}

export function selectDocumentRepresentativeContexts(
  hits: SearchHit[],
  limit = 16,
): SearchHit[] {
  const usable = hits.filter(
    (hit) =>
      hit.content_type !== "toc" &&
      !/(?:本节习题|习题精选|答案与解析|模拟题|单项选择题)/u.test(
        `${hit.section ?? ""} ${hit.content.slice(0, 120)}`,
      ),
  );
  if (usable.length <= limit) return usable;
  const buckets = Array.from({ length: limit }, () => [] as SearchHit[]);
  for (const [index, hit] of usable.entries()) {
    const bucket = Math.min(limit - 1, Math.floor((index * limit) / usable.length));
    buckets[bucket]!.push(hit);
  }
  return buckets
    .map((bucket) => [...bucket].sort(
      (left, right) =>
        representativeRank(right) - representativeRank(left) ||
        left.chunk_index - right.chunk_index,
    )[0])
    .filter((hit): hit is SearchHit => Boolean(hit))
    .sort((left, right) => left.chunk_index - right.chunk_index);
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
  if (!groups.length) return selectDocumentRepresentativeContexts(hits);
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
  const intent = classifiedIntent === "refinement" || classifiedIntent === "summarize_previous"
    ? "new_query"
    : classifiedIntent;
  const inheritedState = options.inheritedState;
  const contextual = [
    "contextual_query",
    "follow_up",
    "explain_previous",
    "continue_previous",
  ].includes(intent);
  const rewrite = rewriteRetrievalQuery(question, history, inheritedState);
  const retrievalQuery = rewrite.query;
  // Contextual prompts such as "给出更详细的回答" contain no topic terms of
  // their own. Search with the expanded query, but validate evidence against the
  // original topic so an incidental match cannot replace the previous subject.
  const relevanceQuery = contextual
    ? inheritedState?.originalQuery ?? retrievalQuery
    : question;
  const retrievalScope = ordinalValue(question)
    ? "local"
    : await classifyRetrievalScope(retrievalQuery);
  const queryType: QueryType = retrievalScope === "local" ? "local" : "overview";
  const retrievalQueries = queryType === "local"
    ? multiFactQueries(retrievalQuery)
    : [retrievalQuery];
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
  if (!scopeDocumentIds.length && documents.length === 1 && knowledgeBaseId) {
    scopeDocumentIds = [documents[0]!.id];
    scopeSource = "knowledge_base";
  } else if (!scopeDocumentIds.length && queryType === "overview" && documents.length === 1) {
    scopeDocumentIds = [documents[0]!.id];
    scopeSource = "dominant";
  }
  if (
    !scopeDocumentIds.length &&
    queryType === "overview" &&
    knowledgeBaseId &&
    requestsMultipleDocumentOverview(question)
  ) {
    scopeDocumentIds = documents.map((document) => document.id);
    scopeSource = "knowledge_base";
  }
  const chapter = requestedChapter(question) ?? (contextual
    ? inheritedState?.chapter ?? undefined
    : undefined);
  let searchResult = await searchConversationQueries(user, retrievalQueries, {
    knowledgeBaseId,
    documentIds: scopeDocumentIds,
    chapter,
    limit: queryType === "overview" ? 120 : 12,
  });

  if (!scopeDocumentIds.length && !/(?:冲突|到底|究竟|不一致)/u.test(question)) {
    const dominant = dominantDocument(searchResult.hits, relevanceQuery);
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
        limit: 12,
      });
    }
  }

  if (
    queryType === "overview" &&
    scopeDocumentIds.length > 1 &&
    !requestsMultipleDocumentOverview(question)
  ) {
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
    const relevanceQueries = multiFactQueries(relevanceQuery);
    const relevantHits = searchResult.hits.filter(
      (hit) =>
        hit.content_type !== "toc" &&
        relevanceQueries.some((candidate) =>
          isSufficientlyRelevantEvidence(candidate, hit),
        ),
    );
    contexts = selectAnswerContexts(
      retrievalQuery,
      dedupeTopK(relevantHits, 6, 3),
      6,
    );
    contexts = await expandAdjacentContexts(user, contexts);
  }
  contexts = contexts
    .map((context) => ({
      ...context,
      content: sanitizeEvidenceContent(context.content),
    }))
    .filter((context) => Boolean(context.content));

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
    originalQuery: question,
    rewriteApplied: rewrite.applied,
    rewriteReason: rewrite.reason,
    resolvedEntities: rewrite.entities,
    // Local contexts have already passed isSufficientlyRelevantEvidence;
    // overview contexts are constructed from an explicit, permission-checked
    // current-version document/chapter scope. Do not run either set through a
    // second generic literal-overlap threshold that rejects overview wording.
    retrievalOutcome: contexts.length
      ? "sufficient"
      : classifyRetrievalOutcome(relevanceQuery, contexts),
  };
}
