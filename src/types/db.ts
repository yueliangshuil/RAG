/** 数据库表对应的 TS 类型（与 supabase/migrations/001_init.sql 对齐） */

export interface Session {
  id: string;
  title: string;
  summary: string | null;
  created_at: string;
  updated_at: string;
}

export interface Message {
  id: string;
  session_id: string;
  role: "user" | "assistant";
  content: string;
  sources: SourceRef[] | null;
  created_at: string;
}

export interface SourceRef {
  document_id: string;
  filename: string;
  content: string;
  similarity: number;
}

export interface DocumentItem {
  id: string;
  filename: string;
  file_type: string;
  content_hash: string;
  chunk_count: number;
  created_at: string;
}
