import { NextResponse } from "next/server";
import { z } from "zod";
import { getSupabaseAdmin } from "@/lib/supabase";
import { getChatModel, getEmbeddings } from "@/lib/llm";
import { getTopK } from "@/lib/env";
import { buildTsQuery } from "@/lib/tokenizer";
import { maybeSummarize, RECENT_WINDOW, saveMessageMemory, searchMessageMemories } from "@/lib/memory";
import type { SourceRef } from "@/types/db";

type Params = { params: Promise<{ id: string }> };

const bodySchema = z.object({
  content: z.string().min(1, "问题不能为空").max(8000, "问题过长"),
});

interface RetrievedChunk {
  id: string;
  document_id: string;
  content: string;
  similarity: number;
}

/** 提问（Phase 2：RRF 混合检索 + 分层记忆；Phase 3 升级 SSE 流式） */
export async function POST(request: Request, { params }: Params) {
  const { id } = await params;

  const parsed = bodySchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "参数不合法" },
      { status: 400 }
    );
  }
  const { content } = parsed.data;

  const db = getSupabaseAdmin();

  // 1. 会话校验
  const { data: session } = await db.from("sessions").select("*").eq("id", id).single();
  if (!session) {
    return NextResponse.json({ error: "会话不存在" }, { status: 404 });
  }

  // 2. 保存用户消息
  const { data: userMsg, error: userErr } = await db
    .from("messages")
    .insert({ session_id: id, role: "user", content })
    .select()
    .single();
  if (userErr || !userMsg) {
    return NextResponse.json({ error: "消息保存失败" }, { status: 500 });
  }

  try {
    // 3. 混合检索（RRF：向量相似度 + BM25 关键词），无关键词时降级为纯向量
    const queryVector = await getEmbeddings().embedQuery(content);
    let matched: RetrievedChunk[] = [];
    const tsquery = buildTsQuery(content);
    if (tsquery.trim() !== "") {
      const { data, error: searchError } = await db.rpc("hybrid_search", {
        query_embedding: JSON.stringify(queryVector),
        query_tsquery: tsquery,
        match_count: getTopK(),
      });
      if (searchError) throw new Error(`混合检索失败: ${searchError.message}`);
      matched = (data ?? []) as RetrievedChunk[];
    } else {
      const { data, error: searchError } = await db.rpc("match_chunks", {
        query_embedding: JSON.stringify(queryVector),
        match_count: getTopK(),
      });
      if (searchError) throw new Error(`向量检索失败: ${searchError.message}`);
      matched = (data ?? []) as RetrievedChunk[];
    }

    // 4. 引用来源（补文档名）
    const docIds = [...new Set(matched.map((c) => c.document_id))];
    const { data: docs } = await db
      .from("documents")
      .select("id, filename")
      .in("id", docIds);
    const filenameMap = new Map((docs ?? []).map((d) => [d.id, d.filename]));
    const sources: SourceRef[] = matched.map((c) => ({
      document_id: c.document_id,
      filename: filenameMap.get(c.document_id) ?? "未知文档",
      content: c.content,
      similarity: c.similarity,
    }));

    // 5. 近期窗口历史（最近 8 轮原文）
    const { data: history } = await db
      .from("messages")
      .select("*")
      .eq("session_id", id)
      .order("created_at", { ascending: false })
      .limit(RECENT_WINDOW);
    const recentHistory = (history ?? []).reverse().filter((m) => m.id !== userMsg.id);

    // 6. 向量记忆：从历史消息中召回与当前问题相关的早期片段（排除近期窗口内消息）
    const memories = await searchMessageMemories(
      id,
      queryVector,
      [userMsg.id, ...recentHistory.map((m) => m.id)]
    );

    // 7. 组装上下文：历史摘要 + 相关历史记忆 + 检索片段 + 近期对话
    const contextText = sources
      .map((s, i) => `[${i + 1}] (来自《${s.filename}》) ${s.content}`)
      .join("\n\n");
    const memoryText = memories
      .map((m, i) => `【记忆${i + 1}】${m.role === "user" ? "用户曾问" : "此前回答"}: ${m.content.slice(0, 300)}`)
      .join("\n");

    const systemPrompt = [
      "你是「智能文档检索与问答平台」的知识库助手。",
      "回答规则：",
      "1. 优先依据【检索片段】作答，引用处标注片段编号（如 [1]）；",
      "2. 可参考【历史摘要】与【相关历史记忆】理解多轮对话上下文；",
      "3. 检索片段不足时，明确说明「知识库中未找到相关内容」，不得编造；",
      "4. 回答使用 Markdown 格式，代码用代码块包裹。",
      "",
      `【历史摘要】${session.summary ?? "（无）"}`,
      "",
      `【相关历史记忆】\n${memoryText || "（无）"}`,
      "",
      `【检索片段】\n${contextText || "（无相关片段）"}`,
    ].join("\n");

    // 8. 调用模型（Phase 2 非流式；Phase 3 改 SSE）
    const model = getChatModel();
    const response = await model.invoke([
      ["system", systemPrompt],
      ...recentHistory.map((m) => [m.role, m.content] as [string, string]),
      ["human", content],
    ]);
    const answer =
      typeof response.content === "string"
        ? response.content
        : JSON.stringify(response.content);

    // 9. 保存回答（流式阶段结束后完整落库）
    const { data: assistantMsg, error: assistantErr } = await db
      .from("messages")
      .insert({ session_id: id, role: "assistant", content: answer, sources })
      .select()
      .single();
    if (assistantErr || !assistantMsg) {
      throw new Error("回答保存失败");
    }

    // 10. 消息向量化入库（异步，不阻塞本轮响应）
    void saveMessageMemory(id, userMsg.id, "user", content);
    void saveMessageMemory(id, assistantMsg.id, "assistant", answer);

    // 11. 滚动摘要：窗口外累积足够消息时增量压缩
    void maybeSummarize(id);

    // 12. 首条消息时用问题生成会话标题
    const sessionUpdate =
      recentHistory.length === 0
        ? { title: content.slice(0, 20), updated_at: new Date().toISOString() }
        : { updated_at: new Date().toISOString() };
    await db.from("sessions").update(sessionUpdate).eq("id", id);

    return NextResponse.json({ answer, sources, message: assistantMsg });
  } catch (err) {
    // 模型调用失败时回滚已保存的用户消息，让前端可重试
    await db.from("messages").delete().eq("id", userMsg.id);
    const message = err instanceof Error ? err.message : "生成回答失败";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
