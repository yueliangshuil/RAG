import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";

type Params = { params: Promise<{ id: string }> };

/**
 * 文档内容端点（约束感知 Agent 的规则内容查看用，服务间令牌保护）
 * 内容由分块按序拼接（与入库前原文一致，不含向量化元数据）。
 */
export async function GET(req: Request, { params }: Params) {
  if (req.headers.get("x-service-token") !== process.env.SERVICE_TOKEN) {
    return NextResponse.json({ error: "未授权的服务调用" }, { status: 401 });
  }
  const { id } = await params;
  const db = getSupabaseAdmin();
  const { data: doc } = await db
    .from("documents")
    .select("id, filename, version, is_latest")
    .eq("id", id)
    .single();
  if (!doc) {
    return NextResponse.json({ error: "文档不存在" }, { status: 404 });
  }
  const { data: chunks, error } = await db
    .from("chunks")
    .select("content")
    .eq("document_id", id)
    .order("chunk_index", { ascending: true });
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({
    document: doc,
    content: (chunks ?? []).map((c) => c.content).join("\n"),
  });
}
