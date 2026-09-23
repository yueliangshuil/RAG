import { getSupabaseAdmin } from "./supabase";
import { getEmbeddings } from "./llm";
import { getTopK } from "./env";
import { buildTsQuery } from "./tokenizer";
import type { SourceRef } from "@/types/db";

/**
 * 独立检索服务：RAG 混合检索（RRF），三级降级（混合 → 向量 → 空结果）
 * 供本项目问答链路与外部服务（constraint-agent 的规则检索 MCP）共用。
 */
interface RetrievedChunk {
  document_id: string;
  content: string;
  similarity: number;
}

export async function retrieveChunks(query: string, topK?: number): Promise<SourceRef[]> {
  const db = getSupabaseAdmin();
  const k = topK ?? getTopK();
  const queryVector = await getEmbeddings().embedQuery(query);

  let matched: RetrievedChunk[] = [];
  try {
    const tsquery = buildTsQuery(query);
    if (tsquery.trim() !== "") {
      const { data, error } = await db.rpc("hybrid_search", {
        query_embedding: JSON.stringify(queryVector),
        query_tsquery: tsquery,
        match_count: k,
      });
      if (error) throw new Error(error.message);
      matched = (data ?? []) as RetrievedChunk[];
    } else {
      throw new Error("query 无可分词 token");
    }
  } catch (hybridErr) {
    console.warn(`[retrieval] 混合检索失败，降级为向量检索: ${hybridErr}`);
    try {
      const { data, error } = await db.rpc("match_chunks", {
        query_embedding: JSON.stringify(queryVector),
        match_count: k,
      });
      if (error) throw new Error(error.message);
      matched = (data ?? []) as RetrievedChunk[];
    } catch (vectorErr) {
      console.error(`[retrieval] 向量检索也失败: ${vectorErr}`);
      return [];
    }
  }

  if (matched.length === 0) return [];
  const docIds = [...new Set(matched.map((c) => c.document_id))];
  const { data: docs } = await db.from("documents").select("id, filename").in("id", docIds);
  const filenameMap = new Map((docs ?? []).map((d) => [d.id, d.filename]));
  return matched.map((c) => ({
    document_id: c.document_id,
    filename: filenameMap.get(c.document_id) ?? "未知文档",
    content: c.content,
    similarity: c.similarity,
  }));
}
