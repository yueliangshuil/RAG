import { NextResponse } from "next/server";
import { z } from "zod";
import { getSupabaseAdmin } from "@/lib/supabase";
import { startGeneration } from "@/lib/generation";

type Params = { params: Promise<{ id: string }> };

const bodySchema = z.object({
  content: z.string().min(1, "问题不能为空").max(8000, "问题过长"),
});

/**
 * 提问（Phase 3）：
 * - 立即落库用户消息与 assistant 占位消息（status=generating）并返回 messageId；
 * - 生成任务在后台运行，不随客户端断开而停止；
 * - 客户端拿到 messageId 后连接 /api/messages/[id]/stream 接收流式内容，
 *   刷新页面后按 messageId + 字符偏移断点续收。
 */
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

  // 2. 空知识库检查：不调模型，直接返回引导消息（良好体验的一部分）
  const docCountRes = await db
    .from("documents")
    .select("id", { count: "exact", head: true });
  const docCount = (docCountRes as { count?: number }).count ?? 0;
  if (docCount === 0) {
    const hint =
      "知识库中还没有文档。\n\n请先在左侧「知识库文档」区上传 PDF / Markdown 文件，我就可以基于文档内容回答问题了。";
    const { data: hintMsg } = await db
      .from("messages")
      .insert({ session_id: id, role: "assistant", content: hint, status: "done" })
      .select()
      .single();

    const historyCountRes = await db
      .from("messages")
      .select("id", { count: "exact", head: true })
      .eq("session_id", id);
    const hintHistoryCount = (historyCountRes as { count?: number }).count ?? 0;
    if (hintHistoryCount <= 1) {
      await db
        .from("sessions")
        .update({ title: content.slice(0, 20), updated_at: new Date().toISOString() })
        .eq("id", id);
    }
    return NextResponse.json({ emptyKnowledgeBase: true, message: hintMsg });
  }

  // 3. 落库用户消息
  const { data: userMsg, error: userErr } = await db
    .from("messages")
    .insert({ session_id: id, role: "user", content })
    .select()
    .single();
  if (userErr || !userMsg) {
    return NextResponse.json({ error: "消息保存失败" }, { status: 500 });
  }

  // 4. 落库 assistant 占位消息（状态机：generating）
  const { data: assistantMsg, error: assistantErr } = await db
    .from("messages")
    .insert({ session_id: id, role: "assistant", content: "", status: "generating" })
    .select()
    .single();
  if (assistantErr || !assistantMsg) {
    await db.from("messages").delete().eq("id", userMsg.id);
    return NextResponse.json({ error: "回答占位消息创建失败" }, { status: 500 });
  }

  // 5. 用户消息向量化 + 首条消息生成会话标题
  void import("@/lib/memory").then(({ saveMessageMemory }) =>
    saveMessageMemory(id, userMsg.id, "user", content)
  );
  const historyCountRes = await db
    .from("messages")
    .select("id", { count: "exact", head: true })
    .eq("session_id", id);
  const historyCount = (historyCountRes as { count?: number }).count ?? 0;
  const sessionUpdate =
    historyCount <= 2
      ? { title: content.slice(0, 20), updated_at: new Date().toISOString() }
      : { updated_at: new Date().toISOString() };
  await db.from("sessions").update(sessionUpdate).eq("id", id);

  // 6. 启动后台生成任务（不 await——客户端断开/刷新不影响生成）
  void startGeneration({ sessionId: id, messageId: assistantMsg.id, question: content }).catch(
    (err) => console.error("[chat] 后台生成任务异常:", err)
  );

  return NextResponse.json(
    { userMessage: userMsg, assistantMessage: assistantMsg },
    { status: 201 }
  );
}
