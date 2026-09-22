import { NextResponse } from "next/server";
import { z } from "zod";
import { getSupabaseAdmin } from "@/lib/supabase";
import { getChatModel, getEmbeddings } from "@/lib/llm";
import { getTopK } from "@/lib/env";
import type { SourceRef } from "@/types/db";

type Params = { params: Promise<{ id: string }> };

const bodySchema = z.object({
  content: z.string().min(1, "问题不能为空").max(8000, "问题过长"),
});

const HISTORY_LIMIT = 16; // 最近 8 轮（Phase 2 分层记忆会在此基础上加摘要与向量记忆）

/** 提问（Phase 1：非流式；Phase 3 升级 SSE 流式 + 会话恢复） */
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
    // 3. 向量检索（pgvector 相似度）
    const queryVector = await getEmbeddings().embedQuery(content);
    const { data: matched, error: matchError } = await db.rpc("match_chunks", {
      query_embedding: JSON.stringify(queryVector),
      match_count: getTopK(),
    });
    if (matchError) {
      throw new Error(`检索失败: ${matchError.message}`);
    }

    // 4. 组装引用来源（补文档名）
    const matchedList = (matched ?? []) as {
      id: string;
      document_id: string;
      content: string;
      similarity: number;
    }[];
    const docIds = [...new Set(matchedList.map((c) => c.document_id))];
    const { data: docs } = await db
      .from("documents")
      .select("id, filename")
      .in("id", docIds);
    const filenameMap = new Map((docs ?? []).map((d) => [d.id, d.filename]));
    const sources: SourceRef[] = matchedList.map((c) => ({
      document_id: c.document_id,
      filename: filenameMap.get(c.document_id) ?? "未知文档",
      content: c.content,
      similarity: c.similarity,
    }));

    // 5. 组装上下文：系统提示 + 检索片段 + 历史对话 + 当前问题
    const contextText = sources
      .map((s, i) => `[${i + 1}] (来自《${s.filename}》) ${s.content}`)
      .join("\n\n");
    const systemPrompt = [
      "你是「智能文档检索与问答平台」的知识库助手。",
      "回答规则：",
      "1. 仅依据【检索片段】作答，引用处标注片段编号（如 [1]）；",
      "2. 检索片段不足时，明确说明「知识库中未找到相关内容」，不得编造；",
      "3. 回答使用 Markdown 格式，代码用代码块包裹。",
      "",
      `【历史摘要】${session.summary ?? "（无）"}`,
      "",
      `【检索片段】\n${contextText || "（无相关片段）"}`,
    ].join("\n");

    const { data: history } = await db
      .from("messages")
      .select("*")
      .eq("session_id", id)
      .order("created_at", { ascending: false })
      .limit(HISTORY_LIMIT);
    const recentHistory = (history ?? []).reverse().filter((m) => m.id !== userMsg.id);

    // 6. 调用模型（Phase 1 非流式）
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

    // 7. 保存回答（流式阶段结束后完整落库）
    const { data: assistantMsg, error: assistantErr } = await db
      .from("messages")
      .insert({ session_id: id, role: "assistant", content: answer, sources })
      .select()
      .single();
    if (assistantErr || !assistantMsg) {
      throw new Error("回答保存失败");
    }

    // 8. 首条消息时用问题生成会话标题
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
