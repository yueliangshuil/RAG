/**
 * SSE 断点续流 E2E 测试（需 dev server 运行在 localhost:3000）：
 * 1. 发起提问 → 拿到 messageId → 连接流，接收部分内容后主动断开（模拟刷新）
 * 2. 以字符偏移重连 → 验证续收无重复、最终 done
 * 3. 校验 DB：状态 done、内容与拼接一致
 * 4. interrupted → /continue → 流式续生成 → done（断点续生成链路）
 * 运行：pnpm tsx scripts/test-stream.ts
 */
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { parseSSEBlock } from "../src/lib/sse";

const BASE = "http://localhost:3000";

function loadEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of readFileSync(".env.local", "utf-8").split("\n")) {
    const idx = line.indexOf("=");
    if (idx > 0 && !line.trim().startsWith("#")) {
      env[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    }
  }
  return env;
}

async function post(path: string, body: unknown) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: await res.json() };
}

interface StreamResult {
  text: string;
  lastId: number;
  endEvent: string;
  error?: string;
}

/** 读取流直到收到 done/interrupted，或收到 n 个 delta 后提前中断 */
async function readStream(
  messageId: string,
  from: number,
  maxDeltas?: number,
  timeoutMs = 180_000
): Promise<StreamResult> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const res = await fetch(`${BASE}/api/messages/${messageId}/stream?from=${from}`, {
    signal: ctrl.signal,
  });
  if (!res.ok || !res.body) throw new Error(`流连接失败: ${res.status}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let lastId = from;
  let endEvent = "";
  let error: string | undefined;
  let deltas = 0;
  let gotDelta = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let sep;
      while ((sep = buffer.indexOf("\n\n")) !== -1) {
        const block = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const ev = parseSSEBlock(block);
        if (!ev) continue;
        if (ev.event === "delta") {
          text += ev.data;
          lastId = ev.id;
          deltas++;
          gotDelta = true;
          if (maxDeltas !== undefined && deltas >= maxDeltas) {
            ctrl.abort();
            clearTimeout(timer);
            return { text, lastId, endEvent: "manual-abort" };
          }
        } else if (ev.event === "done") {
          endEvent = "done";
          clearTimeout(timer);
          return { text, lastId, endEvent };
        } else if (ev.event === "interrupted") {
          endEvent = "interrupted";
          error = JSON.parse(ev.data).error;
          clearTimeout(timer);
          return { text, lastId, endEvent, error };
        }
        if (gotDelta && ev.event === "delta") void 0;
      }
    }
    clearTimeout(timer);
    return { text, lastId, endEvent: endEvent || "unexpected-end" };
  } catch (e) {
    clearTimeout(timer);
    if (ctrl.signal.aborted && endEvent === "" && text !== "") {
      return { text, lastId, endEvent: "manual-abort" };
    }
    throw e;
  }
}

function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error(`✗ ${msg}`);
    process.exit(1);
  }
  console.log(`✓ ${msg}`);
}

async function main() {
  const env = loadEnv();
  const db = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  // ===== 场景 1：断开重连（模拟页面刷新） =====
  console.log("=== 场景 1：流中断开 → 字符偏移重连续收 ===");
  const s = await post("/api/sessions", {});
  const sid = s.data.session.id;
  const chat = await post(`/api/sessions/${sid}/chat`, {
    content: "云舟科技员工请假有什么要求？",
  });
  assert(chat.status === 201, `发起提问返回 201（实际 ${chat.status}）`);
  const msgId = chat.data.assistantMessage.id as string;
  assert(chat.data.assistantMessage.status === "generating", "assistant 消息初始状态为 generating");

  const first = await readStream(msgId, 0, 3);
  assert(first.text.length > 0, `首次连接收到 ${first.text.length} 字符（3 个 delta 后主动断开）`);
  assert(first.endEvent === "manual-abort", "主动断开成功（模拟刷新）");

  const second = await readStream(msgId, first.lastId);
  assert(second.endEvent === "done", `重连后收到 done（实际 ${second.endEvent}）`);
  assert(second.text.length > 0, `续收内容非空（${second.text.length} 字符）`);

  // 校验 DB 状态与内容完整性
  const { data: row } = await db.from("messages").select("*").eq("id", msgId).single();
  assert(row.status === "done", "DB 状态为 done");
  assert(
    row.content === first.text + second.text,
    `DB 内容 = 两段拼接（DB ${row.content.length} 字符 vs 拼接 ${(first.text + second.text).length} 字符）`
  );

  // ===== 场景 2：AbortController 取消任务（切换问题）→ /continue 断点续生成 =====
  console.log("\n=== 场景 2：AbortController 取消 → 优雅取消宽限期 → /continue 恢复 ===");
  // 用要求长文回答的提问：保证生成时长（30s+）远超 5s 取消宽限期，
  // 否则短回答会在宽限期内完成，取消链路无法触发（这是设计正确行为）
  const chat2 = await post(`/api/sessions/${sid}/chat`, {
    content:
      "请写一篇完整的技术文章，详细介绍向量数据库选型方法、混合检索原理、RAG 检索评测指标与文档分块策略，要求不少于 1500 字。",
  });
  const msgId2 = chat2.data.assistantMessage.id as string;

  // 真实中断链路：客户端 AbortController 断开流 → 无订阅者 → 5s 宽限期后后台任务被取消
  const first2 = await readStream(msgId2, 0, 1); // 收到首个 delta 立即断开（模拟用户切换问题）
  assert(first2.text.length > 0, "第二个回答已生成部分内容");
  const partial = first2.text;

  console.log("等待优雅取消宽限期（5s）后任务自动取消...");
  let row2: { status: string; content: string; error: string | null } | null = null;
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 1_000));
    const { data } = await db.from("messages").select("status, content, error").eq("id", msgId2).single();
    if (data?.status === "interrupted") {
      row2 = data;
      break;
    }
  }
  assert(row2?.status === "interrupted", "AbortController 断开后任务在宽限期后被取消，状态 interrupted");
  assert(
    row2!.content.startsWith(partial) || partial.startsWith(row2!.content),
    "中断后保留了已生成部分内容"
  );

  const cont = await post(`/api/messages/${msgId2}/continue`, {});
  assert(cont.status === 200, `/continue 返回 200`);
  const resumed = await readStream(msgId2, row2!.content.length);
  assert(resumed.endEvent === "done", "继续生成后收到 done");
  const { data: final2 } = await db.from("messages").select("*").eq("id", msgId2).single();
  assert(final2.status === "done", "继续生成后 DB 状态为 done");
  assert(
    final2.content.startsWith(row2!.content),
    "继续生成的内容包含中断前的已生成部分"
  );

  // 清理
  await db.from("sessions").delete().eq("id", sid);
  console.log("\n✅ SSE 断点续流 E2E 全部通过");
}

main().catch((e) => {
  console.error("测试失败:", e);
  process.exit(1);
});
