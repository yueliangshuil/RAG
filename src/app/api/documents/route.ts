import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { ingestDocument } from "@/lib/rag";

const MAX_SIZE = 20 * 1024 * 1024; // 20MB
const ALLOWED_TYPES = ["pdf", "md", "txt", "markdown"];

/** 文档列表 */
export async function GET() {
  const db = getSupabaseAdmin();
  const { data, error } = await db
    .from("documents")
    .select("*")
    .order("created_at", { ascending: false });
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ documents: data });
}

/** 上传文档：解析 → 分块 → 嵌入 → 入库（重复文档自动跳过） */
export async function POST(request: Request) {
  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json({ error: "请使用 multipart/form-data 上传文件" }, { status: 400 });
  }

  const file = formData.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "缺少文件字段" }, { status: 400 });
  }
  if (file.size === 0) {
    return NextResponse.json({ error: "文件为空" }, { status: 400 });
  }
  if (file.size > MAX_SIZE) {
    return NextResponse.json({ error: "文件超过 20MB 限制" }, { status: 400 });
  }

  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  if (!ALLOWED_TYPES.includes(ext)) {
    return NextResponse.json({ error: "仅支持 PDF / Markdown / TXT 格式" }, { status: 400 });
  }

  try {
    const buffer = Buffer.from(await file.arrayBuffer());
    const result = await ingestDocument(buffer, file.name);
    if (result.duplicated) {
      return NextResponse.json({ duplicated: true, message: "该文档已存在，已自动跳过" });
    }
    return NextResponse.json({ ...result }, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "文档处理失败";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
