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
}

export interface Citation {
  document_id: number;
  title: string;
  content: string;
  score: number;
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
