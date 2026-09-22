import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { startGeneration } from "@/lib/generation";

type Params = { params: Promise<{ messageId: string }> };

/**
 * 断点续生成：中断的消息（status=interrupted）从已生成内容继续输出，
 * 客户端随后重新连接 stream 路由（from = 已生成部分长度）接收剩余内容。
 */
export async function POST(_request: Request, { params }: Params) {
  const { messageId } = await params;
  const db = getSupabaseAdmin();

  const { data: msg } = await db.from("messages").select("*").eq("id", messageId).single();
  if (!msg) {
    return NextResponse.json({ error: "消息不存在" }, { status: 404 });
  }
  if (msg.status !== "interrupted") {
    return NextResponse.json(
      { error: `当前状态为 ${msg.status}，无需继续生成` },
      { status: 409 }
    );
  }

  // 找到该消息对应的用户提问（前一条 user 消息）
  const { data: prev } = await db
    .from("messages")
    .select("id, role, content")
    .eq("session_id", msg.session_id)
    .lt("created_at", msg.created_at)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const question = prev?.role === "user" ? prev.content : "请继续回答";

  // 置回生成中并启动后台任务
  await db
    .from("messages")
    .update({ status: "generating", error: null })
    .eq("id", messageId);

  void startGeneration({
    sessionId: msg.session_id,
    messageId,
    question,
    continueFrom: msg.content || undefined,
  }).catch((err) => console.error("[continue] 后台生成任务异常:", err));

  return NextResponse.json({ ok: true, messageId });
}
