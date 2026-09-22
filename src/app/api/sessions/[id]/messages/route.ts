import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";

type Params = { params: Promise<{ id: string }> };

/** 会话历史消息（按时间正序，刷新页面恢复对话用） */
export async function GET(_req: Request, { params }: Params) {
  const { id } = await params;
  const db = getSupabaseAdmin();
  const { data, error } = await db
    .from("messages")
    .select("*")
    .eq("session_id", id)
    .order("created_at", { ascending: true });
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ messages: data });
}
