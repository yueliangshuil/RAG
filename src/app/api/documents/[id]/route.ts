import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";

type Params = { params: Promise<{ id: string }> };

/** 删除文档（分块随外键级联删除）；服务间认证同 POST */
export async function DELETE(req: Request, { params }: Params) {
  if (req.headers.get("x-service-token") !== process.env.SERVICE_TOKEN) {
    return NextResponse.json({ error: "未授权的服务调用" }, { status: 401 });
  }
  const { id } = await params;
  const db = getSupabaseAdmin();
  const { error } = await db.from("documents").delete().eq("id", id);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
