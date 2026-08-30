import { Router } from "express";
import { requireUser } from "../auth.js";
import { ApiError, numberId, text } from "../core.js";
import { getDb, nowIso, transaction } from "../db.js";
import {
  fallbackRefinementAnswer,
  refinementCitationsValid,
  type ConversationMessage,
} from "../rag-prompts.js";
import { embeddingGeneration } from "../embeddings.js";
import { packEvidence } from "../rag-pipeline.js";
import {
  answerRefinementWithLLM,
  answerWithLLM,
  llmProviderConfigured,
} from "../llm-provider.js";
import {
  answerCitationsValid,
  answerPreservesEvidenceConflicts,
  extractiveAnswer,
  groundedOverviewAnswer,
  remapCitationReferences,
  toCitations,
} from "../search.js";
import {
  classifyConversationIntent,
  isDocumentInventoryQuery,
  isKnowledgeBaseInventoryQuery,
  isKnowledgeBaseProfileQuery,
  requestedChapter,
  requestsKnowledgeBaseContents,
  retrieveForConversationIntent,
  retrieveQuestionContexts,
  type RetrievalHistoryMessage,
} from "../retrieval.js";
import {
  accessibleDocumentWhere,
  canAccessKnowledgeBase,
  userOf,
} from "../services.js";
import type {
  AuthRequest,
  Citation,
  ConversationRetrievalState,
  QueryType,
  RetrievalScope,
  SearchHit,
  SqlRow,
  StoredRetrievalChunk,
  PackedEvidence,
} from "../types.js";

type StoredHistoryMessage = RetrievalHistoryMessage & {
  retrievalState?: ConversationRetrievalState;
};

async function documentInventory(
  user: ReturnType<typeof userOf>,
  knowledgeBaseId?: number,
): Promise<{ answer: string; documentIds: number[] }> {
  const access = accessibleDocumentWhere(user);
  const parameters: Array<string | number> = [...access.params];
  const join = knowledgeBaseId
    ? "JOIN kb_documents kd ON kd.document_id=d.id"
    : "";
  const clauses = [access.sql];
  if (knowledgeBaseId) {
    clauses.push("kd.knowledge_base_id=?");
    parameters.push(knowledgeBaseId);
  }
  const rows = (await getDb()
    .prepare(
      `SELECT DISTINCT d.id,d.title,d.updated_at
       FROM documents d ${join}
       WHERE ${clauses.join(" AND ")}
       ORDER BY d.updated_at DESC,d.id DESC`,
    )
    .all(...parameters)) as SqlRow[];
  if (!rows.length) {
    return { answer: "当前没有可访问的文档。", documentIds: [] };
  }
  const lines = rows.map((row, index) => `${index + 1}. ${String(row.title)}`);
  return {
    answer: `${knowledgeBaseId ? "当前知识库" : "当前可访问范围"}共有 ${rows.length} 份文档：\n${lines.join("\n")}`,
    documentIds: rows.map((row) => Number(row.id)),
  };
}

async function knowledgeBaseInventory(
  user: ReturnType<typeof userOf>,
  includeDocuments: boolean,
): Promise<{ answer: string; documentIds: number[] }> {
  const admin = ["department_admin", "system_admin"].includes(user.role);
  const rows = (await getDb()
    .prepare(
      `SELECT k.id,k.name,k.description,k.visibility
       FROM knowledge_bases k
       ${admin ? "" : "WHERE k.owner_id=? OR k.visibility IN ('shared','public')"}
       ORDER BY k.updated_at DESC,k.id DESC`,
    )
    .all(...(admin ? [] : [user.id]))) as SqlRow[];
  if (!rows.length) {
    return { answer: "当前没有可访问的知识库。", documentIds: [] };
  }

  const access = accessibleDocumentWhere(user);
  const documents = (await getDb()
    .prepare(
      `SELECT kd.knowledge_base_id,d.id,d.title
       FROM kb_documents kd
       JOIN knowledge_bases k ON k.id=kd.knowledge_base_id
       JOIN documents d ON d.id=kd.document_id
       WHERE ${access.sql}
       ${admin ? "" : "AND (k.owner_id=? OR k.visibility IN ('shared','public'))"}
       ORDER BY kd.knowledge_base_id,d.updated_at DESC,d.id DESC`,
    )
    .all(...access.params, ...(admin ? [] : [user.id]))) as SqlRow[];
  const documentsByKnowledgeBase = new Map<number, SqlRow[]>();
  for (const document of documents) {
    const id = Number(document.knowledge_base_id);
    const group = documentsByKnowledgeBase.get(id) ?? [];
    group.push(document);
    documentsByKnowledgeBase.set(id, group);
  }

  const lines = rows.map((row, index) => {
    const description = String(row.description ?? "").trim();
    const titles = documentsByKnowledgeBase.get(Number(row.id)) ?? [];
    const summary = `${index + 1}. ${String(row.name)}（${titles.length} 份文档）${description ? `：${description}` : ""}`;
    if (!includeDocuments) return summary;
    return titles.length
      ? `${summary}\n   文档：${titles.map((document) => String(document.title)).join("、")}`
      : `${summary}\n   文档：暂无可访问文档`;
  });
  return {
    answer: `${includeDocuments ? "当前可访问的知识库内容" : "当前可访问的知识库"}如下：\n${lines.join("\n")}`,
    documentIds: documents.map((document) => Number(document.id)),
  };
}

async function knowledgeBaseProfile(
  user: ReturnType<typeof userOf>,
  knowledgeBaseId: number,
): Promise<{ answer: string; documentIds: number[] }> {
  const row = await canAccessKnowledgeBase(knowledgeBaseId, user);
  const inventory = await documentInventory(user, knowledgeBaseId);
  const description = String(row.description ?? "").trim() || "暂无简介。";
  return {
    answer: `知识库“${String(row.name)}”：${description}\n${inventory.answer}`,
    documentIds: inventory.documentIds,
  };
}

async function knowledgeBaseIdMentionedInQuestion(
  user: ReturnType<typeof userOf>,
  question: string,
): Promise<number | undefined> {
  const admin = ["department_admin", "system_admin"].includes(user.role);
  const rows = (await getDb()
    .prepare(
      `SELECT id,name FROM knowledge_bases
       ${admin ? "" : "WHERE owner_id=? OR visibility IN ('shared','public')"}
       ORDER BY CHAR_LENGTH(name) DESC,id DESC`,
    )
    .all(...(admin ? [] : [user.id]))) as SqlRow[];
  const compactQuestion = question.replace(/\s+/gu, "");
  const exactMatch = rows.find((row) => {
    const name = String(row.name ?? "").replace(/\s+/gu, "");
    if (!name) return false;
    return name.includes("知识库")
      ? compactQuestion.includes(name)
      : compactQuestion.includes(`${name}知识库`) || compactQuestion.includes(`知识库${name}`);
  });
  if (exactMatch) return Number(exactMatch.id);

  const scopedAlias = compactQuestion.match(/(?:文档|资料|文件)在([^，。！!？?]{1,30}?)知识库/u)?.[1]
    ?? compactQuestion.match(/(?:从|查看|查询)([^，。！!？?]{1,30}?)知识库/u)?.[1];
  const leadingAlias = compactQuestion.match(/^(?:请问|请)?(?:在)?([^，。！!？?]{1,30}?)知识库/u)?.[1];
  const alias = scopedAlias ?? leadingAlias;
  if (!alias || alias.length < 2) return undefined;
  const aliasMatches = rows.filter((row) =>
    String(row.name ?? "").replace(/\s+/gu, "").includes(alias),
  );
  return aliasMatches.length === 1 ? Number(aliasMatches[0]!.id) : undefined;
}

function jsonArray(value: unknown): unknown[] {
  try {
    const parsed = JSON.parse(String(value ?? "[]"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function retrievalState(value: unknown): ConversationRetrievalState | undefined {
  try {
    const parsed = JSON.parse(String(value ?? "null")) as Partial<ConversationRetrievalState> | null;
    if (!parsed || ![1, 2].includes(Number(parsed.version)) || !parsed.originalQuery) return undefined;
    return {
      version: Number(parsed.version) === 2 ? 2 : 1,
      intent: parsed.intent ?? "new_query",
      queryType: parsed.queryType === "overview" ? "overview" : "local",
      retrievalScope: ["local", "document_overview", "chapter_overview"].includes(String(parsed.retrievalScope))
        ? parsed.retrievalScope
        : undefined,
      originalQuery: String(parsed.originalQuery),
      retrievalQuery: String(parsed.retrievalQuery ?? parsed.originalQuery),
      rewriteApplied: Boolean(parsed.rewriteApplied),
      rewriteReason: parsed.rewriteReason ? String(parsed.rewriteReason) : undefined,
      resolvedEntities: Array.isArray(parsed.resolvedEntities) ? parsed.resolvedEntities.map(String) : [],
      embeddingGeneration: parsed.embeddingGeneration ? String(parsed.embeddingGeneration) : null,
      documentVersions: parsed.documentVersions && typeof parsed.documentVersions === "object"
        ? parsed.documentVersions as Record<string, number>
        : {},
      permissionScope: parsed.permissionScope ? String(parsed.permissionScope) : undefined,
      documentIds: Array.isArray(parsed.documentIds) ? parsed.documentIds.map(Number).filter(Number.isInteger) : [],
      chunkIds: Array.isArray(parsed.chunkIds) ? parsed.chunkIds.map(Number).filter(Number.isInteger) : [],
      retrievedChunks: Array.isArray(parsed.retrievedChunks)
        ? parsed.retrievedChunks.slice(0, 12).flatMap((item) => {
            if (!item || typeof item !== "object") return [];
            const chunk = item as Partial<StoredRetrievalChunk>;
            const content = String(chunk.content ?? "").trim().slice(0, 1_600);
            if (!content) return [];
            return [{
              chunkId: chunk.chunkId == null ? null : Number(chunk.chunkId),
              documentId: chunk.documentId == null ? null : Number(chunk.documentId),
              sourceName: String(chunk.sourceName ?? "知识库资料").slice(0, 255),
              content,
              similarityScore: chunk.similarityScore == null ? null : Number(chunk.similarityScore),
              lexicalScore: chunk.lexicalScore == null ? null : Number(chunk.lexicalScore),
              semanticScore: chunk.semanticScore == null ? null : Number(chunk.semanticScore),
              pageStart: chunk.pageStart == null ? null : Number(chunk.pageStart),
              pageEnd: chunk.pageEnd == null ? null : Number(chunk.pageEnd),
              chapter: chunk.chapter ? String(chunk.chapter) : null,
              section: chunk.section ? String(chunk.section) : null,
              contentType: chunk.contentType ?? "content",
              qualityScore: chunk.qualityScore == null ? null : Number(chunk.qualityScore),
            }];
          })
        : [],
      knowledgeBaseId: parsed.knowledgeBaseId ? Number(parsed.knowledgeBaseId) : null,
      chapter: parsed.chapter ? String(parsed.chapter) : null,
      section: parsed.section ? String(parsed.section) : null,
    };
  } catch {
    return undefined;
  }
}

function storeRetrievedChunks(contexts: SearchHit[]): StoredRetrievalChunk[] {
  return contexts.slice(0, 12).map((item) => ({
    chunkId: item.chunk_id,
    documentId: item.document_id,
    sourceName: item.title,
    content: item.content.trim().slice(0, 1_600),
    similarityScore: Number.isFinite(item.score) ? item.score : null,
    lexicalScore: item.lexical_score ?? null,
    semanticScore: item.semantic_score ?? null,
    pageStart: item.page_start,
    pageEnd: item.page_end,
    chapter: item.chapter,
    section: item.section,
    contentType: item.content_type,
    qualityScore: item.quality_score,
  }));
}

function searchHitsFromEvidence(evidence: PackedEvidence[]): SearchHit[] {
  return evidence.map((item) => ({
    chunk_id: item.chunk_ids[0]!,
    source_chunk_ids: item.chunk_ids,
    chunk_index: item.chunk_index,
    document_id: item.document_id,
    document_version: item.document_version,
    title: item.title,
    filename: item.filename,
    category: "",
    tags: [],
    content: item.content,
    score: item.score,
    page_start: item.page_start,
    page_end: item.page_end,
    chapter: item.chapter,
    section: item.section,
    content_type: item.content_type,
    quality_score: item.quality_score,
  }));
}

async function accessibleContextsFromState(
  user: ReturnType<typeof userOf>,
  state?: ConversationRetrievalState,
): Promise<SearchHit[]> {
  const chunkIds = [...new Set(state?.chunkIds ?? [])].filter((id) => Number.isInteger(id) && id > 0);
  if (!chunkIds.length) return [];
  const access = accessibleDocumentWhere(user);
  const generationUnchanged = !state?.embeddingGeneration || state.embeddingGeneration === embeddingGeneration();
  if (!generationUnchanged) return [];
  if (state?.knowledgeBaseId) await canAccessKnowledgeBase(state.knowledgeBaseId, user);
  const knowledgeBaseClause = state?.knowledgeBaseId
    ? "AND EXISTS(SELECT 1 FROM kb_documents kd WHERE kd.document_id=d.id AND kd.knowledge_base_id=?)"
    : "";
  const rows = await getDb()
    .prepare(
      `SELECT c.id AS chunk_id,c.chunk_index,c.document_version,c.content,c.page_start,c.page_end,
        c.chapter,c.section,c.content_type,c.quality_score,
        d.id AS document_id,d.title,d.filename,d.category,d.tags
       FROM document_chunks c JOIN documents d ON d.id=c.document_id
       WHERE c.id IN (${chunkIds.map(() => "?").join(",")})
         AND d.status='ready' AND c.document_version=d.version AND ${access.sql}
         ${knowledgeBaseClause}
       ORDER BY FIELD(c.id,${chunkIds.map(() => "?").join(",")})`,
    )
    .all(...chunkIds, ...access.params, ...(state?.knowledgeBaseId ? [state.knowledgeBaseId] : []), ...chunkIds);
  return rows.map((row) => ({
    chunk_id: Number(row.chunk_id),
    chunk_index: Number(row.chunk_index),
    document_id: Number(row.document_id),
    document_version: Number(row.document_version),
    title: String(row.title),
    filename: String(row.filename),
    category: String(row.category),
    tags: jsonArray(row.tags).map(String),
    content: String(row.content),
    score: 1,
    page_start: row.page_start === null ? null : Number(row.page_start),
    page_end: row.page_end === null ? null : Number(row.page_end),
    chapter: row.chapter ? String(row.chapter) : null,
    section: row.section ? String(row.section) : null,
    content_type: String(row.content_type ?? "content") as SearchHit["content_type"],
    quality_score: Number(row.quality_score ?? 1),
  }));
}

function mergeEvidence(current: SearchHit[], historical: SearchHit[], limit = 6): SearchHit[] {
  const merged = new Map<number, SearchHit>();
  for (const item of [...current, ...historical]) {
    if (!merged.has(item.chunk_id)) merged.set(item.chunk_id, item);
  }
  return [...merged.values()].slice(0, limit);
}

function answerHasEnoughDetail(
  answer: string,
  contexts: Array<{
    content: string;
    document_id: number;
    chapter?: string | null;
    section?: string | null;
  }>,
  queryType: QueryType,
  retrievalScope: RetrievalScope = queryType === "overview" ? "document_overview" : "local",
): boolean {
  if (queryType !== "overview") return true;
  const evidenceHasDetail = contexts.some((item) => item.content.trim().length >= 30);
  if (!evidenceHasDetail) return true;
  const substantive = answer
    .replace(/\[\d+\]/gu, "")
    .replace(/[\s#>*_`-]+/gu, "")
    .trim();
  if (substantive.length < 36) return false;
  const references = [...answer.matchAll(/\[(\d+)\]/gu)]
    .map((match) => Number(match[1]) - 1)
    .filter((index) => index >= 0 && index < contexts.length);
  if (retrievalScope === "document_overview") {
    const documents = new Set(contexts.map((item) => item.document_id));
    const citedDocuments = new Set(
      references.map((index) => contexts[index]?.document_id).filter(Boolean),
    );
    if (documents.size >= 2 && citedDocuments.size < documents.size) return false;
    const chapters = new Set(contexts.map((item) => item.chapter).filter(Boolean));
    const citedChapters = new Set(references.map((index) => contexts[index]?.chapter).filter(Boolean));
    if (chapters.size >= 3 && citedChapters.size < Math.ceil(chapters.size * 0.8)) return false;
  }
  if (retrievalScope === "chapter_overview") {
    const sections = new Set(contexts.map((item) => item.section).filter(Boolean));
    const citedSections = new Set(references.map((index) => contexts[index]?.section).filter(Boolean));
    if (sections.size >= 3 && citedSections.size < Math.ceil(sections.size * 0.6)) return false;
  }
  return true;
}

export function createChatRouter(): Router {
  const router = Router();
  router.use(requireUser);

  router.post("/ask", async (request: AuthRequest, response) => {
    const user = userOf(request);
    const question = text(request.body?.question, "问题", 2_000);
    const knowledgeBaseId = request.body?.knowledge_base_id
      ? numberId(request.body.knowledge_base_id)
      : undefined;
    const requestedSessionId = request.body?.session_id
      ? numberId(request.body.session_id)
      : undefined;
    let history: StoredHistoryMessage[] = [];
    let effectiveKnowledgeBaseId = knowledgeBaseId;
    if (requestedSessionId) {
      const session = (await getDb()
        .prepare(
          "SELECT id,knowledge_base_id FROM chat_sessions WHERE id=? AND user_id=?",
        )
        .get(requestedSessionId, user.id)) as SqlRow | undefined;
      if (!session) throw new ApiError(404, "问答会话不存在");
      effectiveKnowledgeBaseId = session.knowledge_base_id
        ? Number(session.knowledge_base_id)
        : undefined;
      history = (
        await getDb()
          .prepare(
            `SELECT role,content,citations,retrieval_state FROM messages
             WHERE session_id=? ORDER BY id DESC LIMIT 8`,
          )
          .all(requestedSessionId)
      )
        .reverse()
        .map((row) => ({
          role: String(row.role) as ConversationMessage["role"],
          content: String(row.content),
          citations: jsonArray(row.citations) as Citation[],
          retrievalState: retrievalState(row.retrieval_state),
        }));
    }
    if (effectiveKnowledgeBaseId) {
      await canAccessKnowledgeBase(effectiveKnowledgeBaseId, user);
    }
    const latestAssistant = [...history].reverse().find((message) => message.role === "assistant");
    const intent = classifyConversationIntent(question, Boolean(latestAssistant));
    const refinementSource = intent === "refinement"
      ? [...history].reverse().find(
          (message) =>
            message.role === "assistant" &&
            Boolean(message.citations?.length) &&
            !message.content.includes("现有资料没有提供相关信息"),
        ) ?? latestAssistant
      : latestAssistant;
    const inheritedState = refinementSource?.retrievalState;
    const retrievalIntent = intent === "refinement" || intent === "summarize_previous"
      ? "new_query"
      : intent;
    const documentInventoryQuery = isDocumentInventoryQuery(question);
    const knowledgeBaseInventoryQuery = isKnowledgeBaseInventoryQuery(question);
    const knowledgeBaseProfileQuery = isKnowledgeBaseProfileQuery(question);
    const inventoryQuery = documentInventoryQuery || knowledgeBaseInventoryQuery || knowledgeBaseProfileQuery;
    if (documentInventoryQuery && !effectiveKnowledgeBaseId) {
      effectiveKnowledgeBaseId = await knowledgeBaseIdMentionedInQuestion(user, question);
      if (effectiveKnowledgeBaseId) {
        await canAccessKnowledgeBase(effectiveKnowledgeBaseId, user);
      }
    }
    if (knowledgeBaseProfileQuery && !effectiveKnowledgeBaseId) {
      effectiveKnowledgeBaseId = await knowledgeBaseIdMentionedInQuestion(user, question);
      if (effectiveKnowledgeBaseId) {
        await canAccessKnowledgeBase(effectiveKnowledgeBaseId, user);
      }
    }
    const plannedRetrieval = inventoryQuery ? undefined : await retrieveForConversationIntent(intent, () =>
      retrieveQuestionContexts(
        user,
        question,
        history,
        effectiveKnowledgeBaseId,
        {
          intent: retrievalIntent,
          inheritedState,
        },
      ));
    let citations: Citation[] = [];
    let answer = "";
    let engine = "local-extractive";
    let retrievalOutcome: "sufficient" | "retrieval_insufficient" = "sufficient";
    let generationOutcome: "supported" | "generation_unsupported" | "provider_failed" = "supported";
    let retrievalEngine: "lexical" | "hybrid-vector-lexical" | "none" = "none";
    let queryType: QueryType = inheritedState?.queryType ?? "local";
    let scopeDocumentIds: number[] = [];
    let scopeSource: "query" | "history" | "dominant" | "knowledge_base" | "none" = "none";
    let retrievalPerformed = false;
    let state: ConversationRetrievalState;

    if (inventoryQuery) {
      const inventory = knowledgeBaseProfileQuery
        ? effectiveKnowledgeBaseId
          ? await knowledgeBaseProfile(user, effectiveKnowledgeBaseId)
          : await knowledgeBaseInventory(user, false)
        : knowledgeBaseInventoryQuery && !effectiveKnowledgeBaseId
            ? await knowledgeBaseInventory(user, requestsKnowledgeBaseContents(question))
            : await documentInventory(user, effectiveKnowledgeBaseId);
      answer = inventory.answer;
      engine = "local-platform-query";
      scopeDocumentIds = inventory.documentIds;
      scopeSource = effectiveKnowledgeBaseId ? "knowledge_base" : "query";
      state = {
        version: 2,
        intent: "new_query",
        queryType: "local",
        originalQuery: question,
        retrievalQuery: question,
        documentIds: scopeDocumentIds,
        chunkIds: [],
        retrievedChunks: [{
          chunkId: null,
          documentId: null,
          sourceName: "知识库目录",
          content: answer.slice(0, 1_600),
          similarityScore: 1,
        }],
        knowledgeBaseId: effectiveKnowledgeBaseId ?? null,
        chapter: null,
        section: null,
      };
    } else if (!plannedRetrieval && refinementSource) {
      const previousAnswer = refinementSource.content;
      const previousContexts = await accessibleContextsFromState(user, inheritedState);
      const previousEvidence = packEvidence(previousContexts);
      citations = toCitations(searchHitsFromEvidence(previousEvidence));
      answer = fallbackRefinementAnswer(question, previousAnswer);
      engine = "local-refinement-fallback";
      if (!previousEvidence.length) {
        answer = "上一轮证据已失效、被替换或当前无权访问，无法继续基于原证据改写。";
        retrievalOutcome = "retrieval_insufficient";
      } else if (llmProviderConfigured()) {
        try {
          let modelAnswer = await answerRefinementWithLLM(previousAnswer, question, previousEvidence);
          const mustBeShorter = /(?:精简|简短|简洁)/u.test(question);
          const mustBeSingleLine = /(?:一|1)(?:行|句|句话)/u.test(question);
          const maximumLength = mustBeSingleLine
            ? Math.max(80, Math.floor(previousAnswer.length * 0.35))
            : Math.max(120, Math.floor(previousAnswer.length * 0.6));
          if (
            !refinementCitationsValid(modelAnswer, citations.length) ||
            (mustBeShorter && modelAnswer.length > maximumLength) ||
            (mustBeSingleLine && /\n/u.test(modelAnswer.trim()))
          ) {
            modelAnswer = await answerRefinementWithLLM(
              previousAnswer,
              `${question}\n必须保留有效引用编号；若要求精简，输出必须明显短于原回答。`,
              previousEvidence,
            );
          }
          if (
            refinementCitationsValid(modelAnswer, citations.length) &&
            (!mustBeShorter || modelAnswer.length <= maximumLength) &&
            (!mustBeSingleLine || !/\n/u.test(modelAnswer.trim()))
          ) {
            answer = modelAnswer;
            engine = "cloud-llm-api";
          }
        } catch (error) {
          console.warn(
            "LLM API refinement failed; using safe refinement fallback:",
            error instanceof Error ? error.message : error,
          );
        }
      }
      const refinedReferences = remapCitationReferences(answer, citations.length);
      if (refinedReferences) {
        answer = refinedReferences.answer;
        citations = refinedReferences.evidenceIndexes.map((index) => citations[index]!).filter(Boolean);
      }
      const previousQuestion = [...history].reverse().find((message) => message.role === "user")?.content ?? question;
      scopeDocumentIds = inheritedState?.documentIds ?? [
        ...new Set(citations.map((citation) => citation.document_id)),
      ];
      scopeSource = scopeDocumentIds.length ? "history" : "none";
      state = {
        version: 2,
        intent,
        queryType,
        originalQuery: inheritedState?.originalQuery ?? previousQuestion,
        retrievalQuery: inheritedState?.retrievalQuery ?? previousQuestion,
        documentIds: scopeDocumentIds,
        chunkIds: inheritedState?.chunkIds ?? citations.map((citation) => citation.chunk_id),
        retrievedChunks: inheritedState?.retrievedChunks ?? [],
        knowledgeBaseId: inheritedState?.knowledgeBaseId ?? effectiveKnowledgeBaseId ?? null,
        chapter: inheritedState?.chapter ?? citations.find((citation) => citation.chapter)?.chapter ?? null,
        section: inheritedState?.section ?? citations.find((citation) => citation.section)?.section ?? null,
      };
    } else {
      if (!plannedRetrieval) throw new ApiError(400, "当前改写请求缺少可用的上一轮回答");
      const retrieval = plannedRetrieval;
      retrievalPerformed = true;
      const followsPrevious = [
        "contextual_query",
        "follow_up",
        "explain_previous",
        "continue_previous",
      ].includes(intent);
      const historicalContexts = followsPrevious
        ? await accessibleContextsFromState(user, inheritedState)
        : [];
      const rawContexts = followsPrevious
        ? mergeEvidence(retrieval.contexts, historicalContexts)
        : retrieval.contexts.slice(0, retrieval.queryType === "overview" ? 12 : 6);
      retrievalOutcome = retrieval.retrievalOutcome;
      const packedEvidence = retrievalOutcome === "sufficient" ? packEvidence(rawContexts) : [];
      const contexts = searchHitsFromEvidence(packedEvidence);
      queryType = retrieval.queryType;
      retrievalEngine = retrieval.engine;
      scopeDocumentIds = retrieval.scopeDocumentIds;
      scopeSource = retrieval.scopeSource;
      answer = retrieval.queryType === "overview"
        ? groundedOverviewAnswer(question, contexts)
        : extractiveAnswer(question, contexts);
      if (!contexts.length) {
        answer = "现有资料没有提供相关信息，因此无法根据资料确认。";
        retrievalOutcome = "retrieval_insufficient";
      } else if (llmProviderConfigured()) {
        try {
          const conversationHistory = history.map(({ role, content }) => ({ role, content }));
          let modelAnswer = await answerWithLLM(
            question,
            packedEvidence,
            conversationHistory,
            retrieval.queryType,
          );
          if (
            !answerCitationsValid(modelAnswer, contexts.length, retrieval.queryType === "overview") ||
            !answerPreservesEvidenceConflicts(question, modelAnswer, contexts) ||
            !answerHasEnoughDetail(
              modelAnswer,
              packedEvidence,
              retrieval.queryType,
              retrieval.retrievalScope,
            )
          ) {
            modelAnswer = await answerWithLLM(
              `${question}\n请严格让每个事实或章节条目就近标注有效引用编号；概览问题不能只给章节标题，至少概括两个有证据支持的实质信息。`,
              packedEvidence,
              conversationHistory,
              retrieval.queryType,
            );
          }
          if (
            answerCitationsValid(modelAnswer, contexts.length, retrieval.queryType === "overview") &&
            answerPreservesEvidenceConflicts(question, modelAnswer, contexts) &&
            answerHasEnoughDetail(
              modelAnswer,
              contexts,
              retrieval.queryType,
              retrieval.retrievalScope,
            )
          ) {
            answer = modelAnswer;
            engine = "cloud-llm-api";
            generationOutcome = "supported";
          } else {
            engine = "extractive-fallback";
            generationOutcome = "generation_unsupported";
          }
        } catch (error) {
          engine = "extractive-fallback";
          generationOutcome = "provider_failed";
          console.warn(
            "LLM API answer failed; using extractive fallback:",
            error instanceof Error ? error.message : error,
          );
        }
      }
      let citationMapping = remapCitationReferences(answer, contexts.length);
      if (!citationMapping && contexts.length) {
        answer = retrieval.queryType === "overview"
          ? groundedOverviewAnswer(question, contexts)
          : extractiveAnswer(question, contexts);
        engine = "extractive-fallback";
        citationMapping = remapCitationReferences(answer, contexts.length);
      }
      const citedContexts = citationMapping
        ? citationMapping.evidenceIndexes.map((index) => contexts[index]!).filter(Boolean)
        : [];
      if (citationMapping) answer = citationMapping.answer;
      citations = toCitations(citedContexts);
      const selectedSections = [...new Set(citedContexts.map((item) => item.section).filter(Boolean))];
      state = {
        version: 2,
        intent: retrieval.intent,
        queryType: retrieval.queryType,
        retrievalScope: retrieval.retrievalScope,
        originalQuery: followsPrevious
          ? inheritedState?.originalQuery ?? question
          : question,
        retrievalQuery: retrieval.retrievalQuery,
        rewriteApplied: retrieval.rewriteApplied,
        rewriteReason: retrieval.rewriteReason,
        resolvedEntities: retrieval.resolvedEntities,
        embeddingGeneration: embeddingGeneration(),
        documentVersions: Object.fromEntries(contexts.map((item) => [String(item.document_id), item.document_version ?? 1])),
        permissionScope: `${user.id}:${user.role}:${effectiveKnowledgeBaseId ?? "all"}`,
        documentIds: retrieval.scopeDocumentIds.length
          ? retrieval.scopeDocumentIds
          : [...new Set(contexts.map((item) => item.document_id))],
        chunkIds: citedContexts.map((item) => item.chunk_id),
        retrievedChunks: storeRetrievedChunks(citedContexts.length ? citedContexts : contexts),
        knowledgeBaseId: effectiveKnowledgeBaseId ?? null,
        chapter: requestedChapter(question) ?? (followsPrevious ? inheritedState?.chapter : null) ?? null,
        section: selectedSections.length === 1 ? selectedSections[0]! : null,
      };
    }
    const timestamp = nowIso();
    const sessionId = await transaction(async () => {
      let id = requestedSessionId;
      if (id) {
        const session = await getDb()
          .prepare("SELECT id FROM chat_sessions WHERE id=? AND user_id=?")
          .get(id, user.id);
        if (!session) throw new ApiError(404, "问答会话不存在");
      } else {
        const result = await getDb()
          .prepare(
            `INSERT INTO chat_sessions(
              user_id,knowledge_base_id,title,created_at,updated_at
             ) VALUES (?,?,?,?,?)`,
          )
          .run(
            user.id,
            effectiveKnowledgeBaseId ?? null,
            question.slice(0, 30),
            timestamp,
            timestamp,
          );
        id = Number(result.lastInsertRowid);
      }
      await getDb()
        .prepare(
          `INSERT INTO messages(session_id,role,content,citations,retrieval_state,created_at)
           VALUES (?,'user',?,'[]',NULL,?)`,
        )
        .run(id, question, timestamp);
      await getDb()
        .prepare(
          `INSERT INTO messages(session_id,role,content,citations,retrieval_state,created_at)
           VALUES (?,'assistant',?,?,?,?)`,
        )
        .run(id, answer, JSON.stringify(citations), JSON.stringify(state), timestamp);
      await getDb()
        .prepare("UPDATE chat_sessions SET updated_at=? WHERE id=?")
        .run(timestamp, id);
      await getDb()
        .prepare(
          `INSERT INTO search_logs(user_id,query,mode,created_at)
           VALUES (?,?,?,?)`,
        )
        .run(user.id, question, intent, timestamp);
      return id;
    });
    response.json({
      session_id: sessionId,
      answer,
      citations,
      engine,
      retrieval_engine: retrievalEngine,
      retrieval_performed: retrievalPerformed,
      intent,
      retrieval_query: state.retrievalQuery,
      original_query: state.originalQuery,
      rewrite_applied: Boolean(state.rewriteApplied),
      retrieval_outcome: retrievalOutcome,
      generation_outcome: generationOutcome,
      query_type: queryType,
      retrieval_scope: state.retrievalScope ?? (queryType === "overview" ? "document_overview" : "local"),
      scope_document_ids: scopeDocumentIds,
      scope_source: scopeSource,
    });
  });

  router.get("/sessions", async (request: AuthRequest, response) => {
    const user = userOf(request);
    const admin = ["department_admin", "system_admin"].includes(user.role);
    const rows = await getDb()
      .prepare(
        `SELECT s.*,k.name AS knowledge_base_name,
           (SELECT COUNT(*) FROM messages m WHERE m.session_id=s.id) AS message_count
         FROM chat_sessions s
         LEFT JOIN knowledge_bases k ON k.id=s.knowledge_base_id
         WHERE s.user_id=?
           ${admin ? "" : "AND (s.knowledge_base_id IS NULL OR k.owner_id=? OR k.visibility IN ('shared','public'))"}
         ORDER BY s.updated_at DESC`,
      )
      .all(user.id, ...(admin ? [] : [user.id]));
    response.json(rows);
  });

  router.get("/sessions/:id", async (request: AuthRequest, response) => {
    const id = numberId(request.params.id);
    const user = userOf(request);
    const session = (await getDb()
      .prepare("SELECT * FROM chat_sessions WHERE id=? AND user_id=?")
      .get(id, user.id)) as SqlRow | undefined;
    if (!session) throw new ApiError(404, "问答会话不存在");
    if (session.knowledge_base_id) {
      await canAccessKnowledgeBase(Number(session.knowledge_base_id), user);
    }
    const rows = await getDb()
      .prepare("SELECT * FROM messages WHERE session_id=? ORDER BY id")
      .all(id);
    const parsed = rows.map((row) => {
      let citations: Citation[] = [];
      try {
        const value = JSON.parse(String(row.citations ?? "[]"));
        if (Array.isArray(value)) citations = value as Citation[];
      } catch {
        citations = [];
      }
      return { row, citations, state: retrievalState(row.retrieval_state) };
    });
    const citedDocumentIds = [...new Set(
      parsed.flatMap(({ citations, state }) => [
        ...citations.map((item) => item.document_id),
        ...(state?.documentIds ?? []),
      ])
        .filter((documentId) => Number.isSafeInteger(documentId) && documentId > 0),
    )];
    const accessibleIds = new Set<number>();
    if (citedDocumentIds.length) {
      const access = accessibleDocumentWhere(user);
      const accessible = await getDb()
        .prepare(
          `SELECT d.id FROM documents d
           WHERE d.id IN (${citedDocumentIds.map(() => "?").join(",")})
             AND ${access.sql}`,
        )
        .all(...citedDocumentIds, ...access.params);
      for (const row of accessible) accessibleIds.add(Number(row.id));
    }
    const messages = parsed.map(({ row, citations, state }) => {
      const evidenceDocumentIds = [
        ...citations.map((citation) => citation.document_id),
        ...(state?.documentIds ?? []),
      ];
      const revoked = evidenceDocumentIds.some(
        (documentId) => !accessibleIds.has(documentId),
      );
      return {
        ...row,
        content: revoked && row.role === "assistant"
          ? "部分引用资料的访问权限已失效，原回答已隐藏。"
          : row.content,
        citations: revoked ? [] : citations,
        retrieval_state: revoked ? null : row.retrieval_state,
        citation_access_revoked: revoked,
      };
    });
    response.json({ session, messages });
  });

  router.delete("/sessions/:id", async (request: AuthRequest, response) => {
    const result = await getDb()
      .prepare("DELETE FROM chat_sessions WHERE id=? AND user_id=?")
      .run(numberId(request.params.id), userOf(request).id);
    if (!result.changes) throw new ApiError(404, "问答会话不存在");
    response.status(204).end();
  });

  return router;
}
