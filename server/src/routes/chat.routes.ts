import { Router } from "express";
import { requireUser } from "../auth.js";
import { ApiError, numberId, text } from "../core.js";
import { getDb, nowIso, transaction } from "../db.js";
import {
  answerRefinementWithOllama,
  answerWithOllama,
  fallbackRefinementAnswer,
  localModelEnabled,
  refinementCitationsValid,
  type ConversationMessage,
} from "../ollama.js";
import {
  answerCitationsValid,
  extractiveAnswer,
  groundedOverviewAnswer,
  remapCitationReferences,
  toCitations,
} from "../search.js";
import {
  classifyConversationIntent,
  isDocumentInventoryQuery,
  requestedChapter,
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
  SqlRow,
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
    if (!parsed || parsed.version !== 1 || !parsed.originalQuery) return undefined;
    return {
      version: 1,
      intent: parsed.intent ?? "new_query",
      queryType: parsed.queryType === "overview" ? "overview" : "local",
      retrievalScope: ["local", "document_overview", "chapter_overview"].includes(String(parsed.retrievalScope))
        ? parsed.retrievalScope
        : undefined,
      originalQuery: String(parsed.originalQuery),
      retrievalQuery: String(parsed.retrievalQuery ?? parsed.originalQuery),
      documentIds: Array.isArray(parsed.documentIds) ? parsed.documentIds.map(Number).filter(Number.isInteger) : [],
      chunkIds: Array.isArray(parsed.chunkIds) ? parsed.chunkIds.map(Number).filter(Number.isInteger) : [],
      knowledgeBaseId: parsed.knowledgeBaseId ? Number(parsed.knowledgeBaseId) : null,
      chapter: parsed.chapter ? String(parsed.chapter) : null,
      section: parsed.section ? String(parsed.section) : null,
    };
  } catch {
    return undefined;
  }
}

function answerHasEnoughDetail(
  answer: string,
  contexts: Array<{ content: string; chapter?: string | null; section?: string | null }>,
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
    const inventoryQuery = isDocumentInventoryQuery(question);
    if (inventoryQuery && !effectiveKnowledgeBaseId) {
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
          intent: intent === "refinement" ? "new_query" : intent,
          inheritedState,
        },
      ));
    let citations: Citation[] = [];
    let answer = "";
    let engine = "local-extractive";
    let retrievalEngine: "lexical" | "hybrid-vector-lexical" | "none" = "none";
    let queryType: QueryType = inheritedState?.queryType ?? "local";
    let scopeDocumentIds: number[] = [];
    let scopeSource: "query" | "history" | "dominant" | "knowledge_base" | "none" = "none";
    let retrievalPerformed = false;
    let state: ConversationRetrievalState;

    if (inventoryQuery) {
      const inventory = await documentInventory(user, effectiveKnowledgeBaseId);
      answer = inventory.answer;
      engine = "local-platform-query";
      scopeDocumentIds = inventory.documentIds;
      scopeSource = effectiveKnowledgeBaseId ? "knowledge_base" : "query";
      state = {
        version: 1,
        intent: "new_query",
        queryType: "local",
        originalQuery: question,
        retrievalQuery: question,
        documentIds: scopeDocumentIds,
        chunkIds: [],
        knowledgeBaseId: effectiveKnowledgeBaseId ?? null,
        chapter: null,
        section: null,
      };
    } else if (!plannedRetrieval && refinementSource) {
      citations = (refinementSource.citations ?? []) as Citation[];
      const previousAnswer = refinementSource.content;
      answer = fallbackRefinementAnswer(question, previousAnswer);
      engine = "local-refinement-fallback";
      if (localModelEnabled()) {
        try {
          let modelAnswer = await answerRefinementWithOllama(previousAnswer, question);
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
            modelAnswer = await answerRefinementWithOllama(
              previousAnswer,
              `${question}\n必须保留有效引用编号；若要求精简，输出必须明显短于原回答。`,
            );
          }
          if (
            refinementCitationsValid(modelAnswer, citations.length) &&
            (!mustBeShorter || modelAnswer.length <= maximumLength) &&
            (!mustBeSingleLine || !/\n/u.test(modelAnswer.trim()))
          ) {
            answer = modelAnswer;
            engine = "local-qwen3-refinement";
          }
        } catch (error) {
          console.warn(
            "Ollama refinement failed; using safe refinement fallback:",
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
        version: 1,
        intent,
        queryType,
        originalQuery: inheritedState?.originalQuery ?? previousQuestion,
        retrievalQuery: inheritedState?.retrievalQuery ?? previousQuestion,
        documentIds: scopeDocumentIds,
        chunkIds: inheritedState?.chunkIds ?? citations.map((citation) => citation.chunk_id),
        knowledgeBaseId: inheritedState?.knowledgeBaseId ?? effectiveKnowledgeBaseId ?? null,
        chapter: inheritedState?.chapter ?? citations.find((citation) => citation.chapter)?.chapter ?? null,
        section: inheritedState?.section ?? citations.find((citation) => citation.section)?.section ?? null,
      };
    } else {
      if (!plannedRetrieval) throw new ApiError(400, "当前改写请求缺少可用的上一轮回答");
      const retrieval = plannedRetrieval;
      retrievalPerformed = true;
      const contexts = retrieval.contexts;
      queryType = retrieval.queryType;
      retrievalEngine = retrieval.engine;
      scopeDocumentIds = retrieval.scopeDocumentIds;
      scopeSource = retrieval.scopeSource;
      answer = retrieval.queryType === "overview"
        ? groundedOverviewAnswer(question, contexts)
        : extractiveAnswer(question, contexts);
      if (!contexts.length) {
        answer = "现有资料没有提供相关信息，因此无法根据资料确认。";
      } else if (localModelEnabled()) {
        try {
          const conversationHistory = history.map(({ role, content }) => ({ role, content }));
          let modelAnswer = await answerWithOllama(
            question,
            contexts,
            conversationHistory,
            retrieval.queryType,
          );
          if (
            !answerCitationsValid(modelAnswer, contexts.length, retrieval.queryType === "overview") ||
            !answerHasEnoughDetail(
              modelAnswer,
              contexts,
              retrieval.queryType,
              retrieval.retrievalScope,
            )
          ) {
            modelAnswer = await answerWithOllama(
              `${question}\n请严格让每个事实或章节条目就近标注有效引用编号；概览问题不能只给章节标题，至少概括两个有证据支持的实质信息。`,
              contexts,
              conversationHistory,
              retrieval.queryType,
            );
          }
          if (
            answerCitationsValid(modelAnswer, contexts.length, retrieval.queryType === "overview") &&
            answerHasEnoughDetail(
              modelAnswer,
              contexts,
              retrieval.queryType,
              retrieval.retrievalScope,
            )
          ) {
            answer = modelAnswer;
            engine = "local-qwen3-rag";
          } else {
            engine = "local-extractive-fallback";
          }
        } catch (error) {
          engine = "local-extractive-fallback";
          console.warn(
            "Ollama answer failed; using extractive fallback:",
            error instanceof Error ? error.message : error,
          );
        }
      }
      let citationMapping = remapCitationReferences(answer, contexts.length);
      if (!citationMapping && contexts.length) {
        answer = retrieval.queryType === "overview"
          ? groundedOverviewAnswer(question, contexts)
          : extractiveAnswer(question, contexts);
        engine = "local-extractive-fallback";
        citationMapping = remapCitationReferences(answer, contexts.length);
      }
      const citedContexts = citationMapping
        ? citationMapping.evidenceIndexes.map((index) => contexts[index]!).filter(Boolean)
        : [];
      if (citationMapping) answer = citationMapping.answer;
      citations = toCitations(citedContexts);
      const selectedSections = [...new Set(citedContexts.map((item) => item.section).filter(Boolean))];
      state = {
        version: 1,
        intent: retrieval.intent,
        queryType: retrieval.queryType,
        retrievalScope: retrieval.retrievalScope,
        originalQuery: intent === "contextual_query"
          ? inheritedState?.originalQuery ?? question
          : question,
        retrievalQuery: retrieval.retrievalQuery,
        documentIds: retrieval.scopeDocumentIds.length
          ? retrieval.scopeDocumentIds
          : [...new Set(contexts.map((item) => item.document_id))],
        chunkIds: citedContexts.map((item) => item.chunk_id),
        knowledgeBaseId: effectiveKnowledgeBaseId ?? null,
        chapter: requestedChapter(question) ?? (intent === "contextual_query" ? inheritedState?.chapter : null) ?? null,
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
      query_type: queryType,
      scope_document_ids: scopeDocumentIds,
      scope_source: scopeSource,
    });
  });

  router.get("/sessions", async (request: AuthRequest, response) => {
    const rows = await getDb()
      .prepare(
        `SELECT s.*,k.name AS knowledge_base_name,
           (SELECT COUNT(*) FROM messages m WHERE m.session_id=s.id) AS message_count
         FROM chat_sessions s
         LEFT JOIN knowledge_bases k ON k.id=s.knowledge_base_id
         WHERE s.user_id=? ORDER BY s.updated_at DESC`,
      )
      .all(userOf(request).id);
    response.json(rows);
  });

  router.get("/sessions/:id", async (request: AuthRequest, response) => {
    const id = numberId(request.params.id);
    const session = (await getDb()
      .prepare("SELECT * FROM chat_sessions WHERE id=? AND user_id=?")
      .get(id, userOf(request).id)) as SqlRow | undefined;
    if (!session) throw new ApiError(404, "问答会话不存在");
    const messages = (
      await getDb()
        .prepare("SELECT * FROM messages WHERE session_id=? ORDER BY id")
        .all(id)
    ).map((row) => ({
      ...row,
      citations: JSON.parse(String(row.citations ?? "[]")),
    }));
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
