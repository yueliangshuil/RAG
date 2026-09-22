import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";

type Params = { params: Promise<{ id: string }> };

/** 会话详情 */
export async function GET(_req: Request, { params }: Params) {
  const { id } = await params;
  const db = getSupabaseAdmin();
  const { data, error } = await db.from("sessions").select("*").eq("id", id).single();
  if (error) {
    return NextResponse.json({ error: "会话不存在" }, { status: 404 });
  }
  return NextResponse.json({ session: data });
}

/** 删除会话（消息随外键级联删除） */
export async function DELETE(_req: Request, { params }: Params) {
  const { id } = await params;
  const db = getSupabaseAdmin();
  const { error } = await db.from("sessions").delete().eq("id", id);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
