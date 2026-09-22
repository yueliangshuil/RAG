import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";

/** 会话列表（按更新时间倒序） */
export async function GET() {
  const db = getSupabaseAdmin();
  const { data, error } = await db
    .from("sessions")
    .select("*")
    .order("updated_at", { ascending: false });
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ sessions: data });
}

/** 新建会话 */
export async function POST() {
  const db = getSupabaseAdmin();
  const { data, error } = await db
    .from("sessions")
    .insert({ title: "新对话" })
    .select()
    .single();
  if (error || !data) {
    return NextResponse.json({ error: error?.message ?? "创建失败" }, { status: 500 });
  }
  return NextResponse.json({ session: data }, { status: 201 });
}
