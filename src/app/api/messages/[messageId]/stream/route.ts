import { getSupabaseAdmin } from "@/lib/supabase";
import { CANCEL_GRACE_MS, getBuffer } from "@/lib/generation";
import { encodeSSE } from "@/lib/sse";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

type Params = { params: Promise<{ messageId: string }> };

/**
 * SSE 订阅：按消息 ID + 字符偏移（from）断点续收流式内容
 *
 * 协议：
 * - `from` 查询参数 = 客户端已收到的累计字符数（Last-Event-ID 语义）；
 * - delta 事件的 id 为该事件后累计字符长度，客户端据此回传 from；
 * - 已完成的回答直接从 DB 完整文本切片补发；
 * - 缓冲不存在且状态为 generating → 判定后台任务已丢失（如服务重启），
 *   置 interrupted 并通知客户端走 /continue；
 * - 15s 心跳 ping 保活，模型卡顿期间客户端仍能确认连接正常；
 * - 客户端断开且无其他订阅者时，宽限期（CANCEL_GRACE_MS）后取消后台任务
 *   （切换问题=主动取消），宽限期内重连则撤销（刷新续聊=后台继续跑）。
 */
export async function GET(request: Request, { params }: Params) {
  const { messageId } = await params;
  const from = Math.max(
    0,
    Number(new URL(request.url).searchParams.get("from") ?? "0") || 0
  );

  const db = getSupabaseAdmin();
  const { data: msg } = await db.from("messages").select("*").eq("id", messageId).single();
  if (!msg) {
    return Response.json({ error: "消息不存在" }, { status: 404 });
  }

  const encoder = new TextEncoder();
  let closed = false;
  let heartbeat: ReturnType<typeof setInterval> | null = null;

  const stream = new ReadableStream({
    async start(controller) {
      let buf: ReturnType<typeof getBuffer> = undefined;
      let cursor = 0;
      let cumulative = 0;

      const send = (id: number, event: string, data: string) => {
        if (!closed) controller.enqueue(encoder.encode(encodeSSE(id, event, data)));
      };
      const close = () => {
        if (closed) return;
        closed = true;
        if (heartbeat) clearInterval(heartbeat);
        try {
          controller.close();
        } catch {
          /* 已关闭 */
        }
      };

      // 事件处理器（先声明，避免 abort 回调触发时 TDZ）
      const sub = (chunk: string, cum: number) => send(cum, "delta", chunk);
      const forwardStage = (stage: string) => send(cumulative, "stage", stage);
      const onDone = (cum: number) => {
        send(cum, "done", JSON.stringify({ status: "done" }));
        close();
      };
      const onInterrupted = (reason: string, cum: number) => {
        send(cum, "interrupted", JSON.stringify({ status: "interrupted", error: reason }));
        close();
      };

      const removeHandlers = () => {
        if (buf) {
          buf.subscribers.delete(sub);
          buf.stageListeners.delete(forwardStage);
          buf.onDone.delete(onDone);
          buf.onInterrupted.delete(onInterrupted);
        }
      };
      const cleanup = () => {
        removeHandlers();
        close();
      };

      /** 优雅取消：无订阅者时宽限期后取消后台任务（刷新重连会先撤销定时器） */
      const scheduleCancelIfNoListeners = () => {
        if (buf && !buf.done && !buf.failed && buf.subscribers.size === 0) {
          console.log(`[stream] 无订阅者，${CANCEL_GRACE_MS / 1000}s 后取消任务: ${messageId.slice(0, 8)}`);
          buf.cancelTimer = setTimeout(() => {
            console.log(`[stream] 宽限期到，取消任务: ${messageId.slice(0, 8)}`);
            buf?.cancelController.abort();
          }, CANCEL_GRACE_MS);
        }
      };
      request.signal.addEventListener("abort", () => {
        // 注意：closed 必须在 cleanup() 之前捕获——cleanup 会置 closed=true
        const naturalEnd = closed;
        cleanup();
        if (!naturalEnd) scheduleCancelIfNoListeners();
      });

      // 心跳：15s 无内容时发送 ping，防止代理误断 + 客户端卡顿感知
      heartbeat = setInterval(() => send(0, "ping", ""), 15_000);

      // ===== 已完成：从 DB 完整文本按字符偏移切片补发 =====
      if (msg.status === "done") {
        if (from < msg.content.length) {
          send(msg.content.length, "delta", msg.content.slice(from));
        }
        send(msg.content.length, "done", JSON.stringify({ status: "done" }));
        close();
        return;
      }

      // ===== 中断：通知客户端可继续生成 =====
      if (msg.status === "interrupted") {
        send(
          msg.content.length,
          "interrupted",
          JSON.stringify({ status: "interrupted", error: msg.error, content: msg.content })
        );
        close();
        return;
      }

      // ===== 生成中：尝试挂接内存缓冲 =====
      buf = getBuffer(messageId);
      if (!buf) {
        // 缓冲不存在：任务可能刚完成（竞态）或已丢失（服务重启）
        const { data: fresh } = await db
          .from("messages")
          .select("*")
          .eq("id", messageId)
          .single();
        if (fresh?.status === "done") {
          if (from < fresh.content.length) {
            send(fresh.content.length, "delta", fresh.content.slice(from));
          }
          send(fresh.content.length, "done", JSON.stringify({ status: "done" }));
          close();
          return;
        }
        if (fresh?.status === "generating") {
          await db
            .from("messages")
            .update({ status: "interrupted", error: "生成任务已丢失（服务重启），请继续生成" })
            .eq("id", messageId);
        }
        send(
          fresh?.content.length ?? 0,
          "interrupted",
          JSON.stringify({
            status: "interrupted",
            error: fresh?.error ?? "生成中断",
            content: fresh?.content ?? "",
          })
        );
        close();
        return;
      }

      // ===== 缓冲重放：从字符偏移 from 起补发（天然去重） =====
      const replay = () => {
        while (cursor < buf.chunks.length) {
          const piece = buf.chunks[cursor];
          const start = cumulative;
          cumulative += piece.length;
          cursor++;
          if (cumulative > from) {
            const tail = piece.slice(Math.max(0, from - start));
            send(cumulative, "delta", tail);
          }
        }
      };
      replay();

      // 新订阅者接入：撤销等待中的取消定时器（刷新重连场景）
      if (buf.cancelTimer) {
        clearTimeout(buf.cancelTimer);
        buf.cancelTimer = null;
      }

      buf.subscribers.add(sub);
      buf.stageListeners.add(forwardStage);
      buf.onDone.add(onDone);
      buf.onInterrupted.add(onInterrupted);

      // 竞态防护：若任务在订阅完成前已结束，主动补发终态事件，避免流永不关闭
      if (buf.done) {
        onDone(buf.total);
      } else if (buf.failed) {
        onInterrupted("生成失败", buf.total);
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
