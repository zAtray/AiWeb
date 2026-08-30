export type UserRole = "user" | "department_admin" | "system_admin";
export type ViewName =
  | "dashboard"
  | "knowledge"
  | "documents"
  | "search"
  | "chat"
  | "shared"
  | "admin";

export interface User {
  id: number;
  username: string;
  email: string | null;
  phone: string | null;
  role: UserRole;
  created_at: string;
}

export interface KnowledgeBase {
  id: number;
  owner_id: number;
  owner_name?: string;
  name: string;
  description: string;
  visibility: "private" | "shared" | "public";
  document_count: number;
  created_at: string;
  updated_at: string;
}

export interface DocumentItem {
  id: number;
  owner_id: number;
  owner_name: string;
  title: string;
  filename: string;
  file_type: string;
  file_size: number;
  category: string;
  tags: string[];
  version: number;
  share_status: "private" | "pending" | "shared" | "rejected";
  share_note: string;
  views: number;
  downloads: number;
  favorite: boolean;
  liked: boolean;
  like_count: number;
  favorite_count: number;
  comment_count: number;
  knowledge_base_count: number;
  content?: string;
  created_at: string;
  updated_at: string;
  knowledge_bases?: Array<{ id: number; name: string }>;
  versions?: Array<{
    id: number;
    version: number;
    filename: string;
    file_size: number;
    created_at: string;
  }>;
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
  page_start: number | null;
  page_end: number | null;
  chapter: string | null;
  section: string | null;
  content_type: "content" | "heading" | "toc";
  quality_score: number;
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

export interface ChatMessage {
  id?: number;
  role: "user" | "assistant";
  content: string;
  citations: Citation[];
  created_at?: string;
}

export interface ChatSession {
  id: number;
  title: string;
  knowledge_base_id: number | null;
  knowledge_base_name: string | null;
  message_count: number;
  updated_at: string;
}

export interface ModelConnectionStatus {
  status: "disabled" | "connected" | "model_missing" | "offline";
  configured: boolean;
  connected: boolean;
  model: string | null;
  model_available: boolean;
  latency_ms: number | null;
  answer_model: {
    configured: boolean;
    name: string | null;
    available: boolean;
  };
  embedding_model: {
    configured: boolean;
    name: string | null;
    available: boolean;
  };
  embedding_index: {
    chunks: number;
    indexed: number;
    pending: number;
  } | null;
}

export interface AppConfig {
  upload: {
    max_mb: number;
    allowed_extensions: string[];
    pdf_ocr_enabled: boolean;
    ocr_available: boolean;
    ocr_message: string;
    pdf_ocr_max_pages: number;
  };
}

export type RetrievalEngine = "lexical" | "hybrid-vector-lexical";

export interface SearchResponse {
  query: string;
  mode: "fulltext";
  retrieval_engine: RetrievalEngine;
  results: SearchHit[];
  related_documents: RelatedDocument[];
}

export interface RelatedDocument {
  id: number;
  title: string;
  category: string;
  tags: string[];
  score: number;
  matched_fragments: number;
}

export interface ChatResponse {
  session_id: number;
  answer: string;
  citations: Citation[];
  engine:
    | "cloud-llm-api"
    | "extractive-fallback"
    | "local-extractive"
    | "local-refinement-fallback"
    | "local-platform-query";
  retrieval_engine: RetrievalEngine | "none";
  intent:
    | "new_query"
    | "refinement"
    | "follow_up"
    | "summarize_previous"
    | "explain_previous"
    | "continue_previous"
    | "contextual_query"
    | "overview";
  retrieval_query: string;
  original_query: string;
  rewrite_applied: boolean;
  retrieval_outcome: "sufficient" | "retrieval_insufficient";
  generation_outcome: "supported" | "generation_unsupported" | "provider_failed";
  retrieval_performed: boolean;
  query_type: "local" | "overview";
  retrieval_scope: "local" | "document_overview" | "chapter_overview";
  scope_document_ids: number[];
  scope_source: "query" | "history" | "dominant" | "knowledge_base" | "none";
}

export interface CommentItem {
  id: number;
  user_id: number;
  username: string;
  content: string;
  created_at: string;
}

export interface DashboardStats {
  documents: number;
  knowledge_bases: number;
  views: number;
  downloads: number;
  searches: number;
  categories: Array<{ name: string; value: number }>;
  hot_keywords: Array<{ name: string; value: number }>;
  search_trend: Array<{ date: string; value: number }>;
  popularDocuments: Array<{
    id: number;
    title: string;
    category: string;
    created_at: string;
    views: number;
    downloads: number;
    popularity: number;
  }>;
  latestDocuments: Array<{
    id: number;
    title: string;
    category: string;
    created_at: string;
    views: number;
    downloads: number;
  }>;
}
