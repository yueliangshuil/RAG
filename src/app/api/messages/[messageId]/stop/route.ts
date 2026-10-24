import { stopGeneration } from "@/lib/generation";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ messageId: string }> };

/**
 * 用户主动停止生成（DEV_LOG #24 生命周期状态机）：
 * 显式 stop 接口把"主动停止"与"网络断连"分离——
 * 主动停止：置 userStopped 标记 + 立即 abort 模型调用 → stopped 终态（不提供继续生成）；
 * 网络断连：不经过本接口 → 走宽限期 → interrupted（可继续生成）。
 * 前端停止按钮两步操作：先调本接口，再 abort SSE 连接。
 */
export async function POST(_request: Request, { params }: Params) {
  const { messageId } = await params;
  const result = await stopGeneration(messageId);
  if (result === "not_found") {
    return Response.json({ stopped: false, message: "任务不存在或已结束" });
  }
  return Response.json({ stopped: true });
}
