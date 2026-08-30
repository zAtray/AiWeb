import type { Request } from "express";

export type UserRole = "user" | "department_admin" | "system_admin";

export interface User {
  id: number;
  username: string;
  email: string | null;
  phone: string | null;
  role: UserRole;
  created_at: string;
}

export interface SearchHit {
  chunk_id: number;
  chunk_index: number;
  document_id: number;
  document_version?: number;
  title: string;
  filename?: string;
  category: string;
  tags: string[];
  content: string;
  score: number;
  lexical_score?: number;
  semantic_score?: number;
  content_rank?: number;
  metadata_rank?: number;
  exact_rank?: number;
  vector_rank?: number;
  rrf_score?: number;
  embedding_generation?: string;
  source_chunk_ids?: number[];
  page_start: number | null;
  page_end: number | null;
  chapter: string | null;
  section: string | null;
  content_type: "content" | "heading" | "toc";
  quality_score: number;
}

export type QueryType = "local" | "overview";
export type RetrievalScope = "local" | "document_overview" | "chapter_overview";

export type ConversationIntent =
  | "new_query"
  | "refinement"
  | "follow_up"
  | "summarize_previous"
  | "explain_previous"
  | "continue_previous"
  | "contextual_query"
  | "overview";

export interface StoredRetrievalChunk {
  chunkId: number | null;
  documentId: number | null;
  sourceName: string;
  content: string;
  similarityScore: number | null;
  lexicalScore?: number | null;
  semanticScore?: number | null;
  pageStart?: number | null;
  pageEnd?: number | null;
  chapter?: string | null;
  section?: string | null;
  contentType?: SearchHit["content_type"];
  qualityScore?: number | null;
}

export interface ConversationRetrievalState {
  version: 1 | 2;
  intent: ConversationIntent;
  queryType: QueryType;
  retrievalScope?: RetrievalScope;
  originalQuery: string;
  retrievalQuery: string;
  rewriteApplied?: boolean;
  rewriteReason?: string;
  resolvedEntities?: string[];
  embeddingGeneration?: string | null;
  documentVersions?: Record<string, number>;
  permissionScope?: string;
  documentIds: number[];
  chunkIds: number[];
  retrievedChunks?: StoredRetrievalChunk[];
  knowledgeBaseId: number | null;
  chapter: string | null;
  section: string | null;
}

export type RetrievalEngine = "lexical" | "hybrid-vector-lexical";

export interface SearchResult {
  engine: RetrievalEngine;
  hits: SearchHit[];
}

export interface Citation {
  document_id: number;
  title: string;
  content: string;
  score: number;
  chunk_id: number;
  chunk_ids?: number[];
  document_version?: number;
  chunk_index: number;
  page_start: number | null;
  page_end: number | null;
  chapter: string | null;
  section: string | null;
}

export interface PackedEvidence {
  evidence_id: number;
  document_id: number;
  document_version: number;
  title: string;
  filename: string;
  content: string;
  chunk_ids: number[];
  chunk_index: number;
  score: number;
  page_start: number | null;
  page_end: number | null;
  chapter: string | null;
  section: string | null;
  content_type: SearchHit["content_type"];
  quality_score: number;
  redactions: number;
}

export interface AuthRequest extends Request {
  user?: User;
}

export interface UserRow {
  id: number;
  username: string;
  email: string | null;
  phone: string | null;
  password_hash: string;
  role: UserRole;
  created_at: string;
}

export type SqlRow = Record<string, unknown>;
