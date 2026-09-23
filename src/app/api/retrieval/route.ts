import { NextResponse } from "next/server";
import { retrieveChunks } from "@/lib/retrieval";

export const dynamic = "force-dynamic";

/**
 * 独立检索端点：对外暴露 RAG 混合检索能力
 * 供 constraint-agent 的「规则检索 MCP」调用（项目联动：RAG=检索服务，Agent=编排服务）
 * GET /api/retrieval?query=生产发布约束&topK=5
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const query = (url.searchParams.get("query") ?? "").trim();
  if (!query) {
    return NextResponse.json({ error: "缺少 query 参数" }, { status: 400 });
  }
  const topKRaw = Number(url.searchParams.get("topK") ?? "5");
  const topK = Number.isNaN(topKRaw) ? 5 : Math.min(Math.max(topKRaw, 1), 20);

  try {
    const chunks = await retrieveChunks(query, topK);
    return NextResponse.json({ query, chunks });
  } catch (err) {
    const message = err instanceof Error ? err.message : "检索失败";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
