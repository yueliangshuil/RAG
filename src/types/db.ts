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
  /** 生成状态机：generating（后台生成中）/ done / interrupted（可继续生成） */
  status: "generating" | "done" | "interrupted";
  /** 中断/失败原因（前端展示） */
  error: string | null;
  created_at: string;
  /** 客户端专属（不入库）：当前生成阶段，如 thinking */
  stage?: string;
  /** 客户端专属（不入库）：模型响应缓慢提示 */
  slowNotice?: boolean;
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
