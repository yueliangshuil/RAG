import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";

type Params = { params: Promise<{ id: string }> };

/** 删除文档（分块随外键级联删除） */
export async function DELETE(_req: Request, { params }: Params) {
  const { id } = await params;
  const db = getSupabaseAdmin();
  const { error } = await db.from("documents").delete().eq("id", id);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
