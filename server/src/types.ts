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
  title: string;
  category: string;
  tags: string[];
  content: string;
  score: number;
  lexical_score?: number;
  semantic_score?: number;
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
  | "contextual_query"
  | "overview";

export interface ConversationRetrievalState {
  version: 1;
  intent: ConversationIntent;
  queryType: QueryType;
  retrievalScope?: RetrievalScope;
  originalQuery: string;
  retrievalQuery: string;
  documentIds: number[];
  chunkIds: number[];
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
  chunk_index: number;
  page_start: number | null;
  page_end: number | null;
  chapter: string | null;
  section: string | null;
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
