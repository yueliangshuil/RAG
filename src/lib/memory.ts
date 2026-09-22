import { getSupabaseAdmin } from "./supabase";
import { getChatModel, getEmbeddings } from "./llm";

/**
 * 分层记忆（Phase 2）：
 * - 近期窗口：最近 N 条消息原文直接进上下文（chat 路由中处理）
 * - 向量记忆：所有消息向量化入库，按相关性召回早期细节
 * - 滚动摘要：窗口外的历史增量压缩为结构化摘要，存 sessions.summary
 *
 * 原则：消息完整保存在 messages 表永不删除，压缩只影响"注入上下文的内容"。
 */

export const RECENT_WINDOW = 16; // 近期窗口：最近 8 轮

export interface MemoryHit {
  message_id: string;
  role: string;
  content: string;
  similarity: number;
}

/** 消息向量化入库（失败不阻塞主流程，主链路已有完整消息落库） */
export async function saveMessageMemory(
  sessionId: string,
  messageId: string,
  role: "user" | "assistant",
  content: string
): Promise<void> {
  const db = getSupabaseAdmin();
  try {
    const [vec] = await getEmbeddings().embedDocuments([content]);
    const { error } = await db.from("message_memories").insert({
      session_id: sessionId,
      message_id: messageId,
      role,
      content,
      embedding: JSON.stringify(vec),
    });
    if (error) console.error("[memory] 写入失败:", error.message);
  } catch (err) {
    console.error("[memory] 向量化失败:", err);
  }
}

/** 按当前问题检索相关历史记忆（排除近期窗口内消息，避免重复注入） */
export async function searchMessageMemories(
  sessionId: string,
  queryVector: number[],
  excludeMessageIds: string[],
  topK = 3
): Promise<MemoryHit[]> {
  const db = getSupabaseAdmin();
  const { data } = await db.rpc("match_memories", {
    query_embedding: JSON.stringify(queryVector),
    sid: sessionId,
    match_count: topK + excludeMessageIds.length + 3,
  });
  return ((data ?? []) as MemoryHit[])
    .filter((m) => !excludeMessageIds.includes(m.message_id))
    .slice(0, topK);
}

const SUMMARY_TRIGGER = 8; // 窗口外每累积 8 条消息触发一次压缩

/**
 * 滚动摘要（增量压缩）：
 * 当窗口外未压缩消息 ≥ SUMMARY_TRIGGER 时，把「旧摘要 + 窗口外消息」压成新结构化摘要。
 * sessions.summarized_upto 记录已折叠进度，避免每轮重复压缩。
 */
export async function maybeSummarize(sessionId: string): Promise<void> {
  const db = getSupabaseAdmin();

  const { count } = await db
    .from("messages")
    .select("id", { count: "exact", head: true })
    .eq("session_id", sessionId);
  const total = count ?? 0;
  const { data: session } = await db.from("sessions").select("*").eq("id", sessionId).single();
  if (!session) return;

  const unsummarized = total - RECENT_WINDOW - session.summarized_upto;
  if (unsummarized < SUMMARY_TRIGGER) return;

  // 取已折叠进度之后、近期窗口之外的消息
  const take = total - RECENT_WINDOW - session.summarized_upto;
  const { data: oldMessages } = await db
    .from("messages")
    .select("role, content")
    .eq("session_id", sessionId)
    .order("created_at", { ascending: true })
    .range(session.summarized_upto, session.summarized_upto + take - 1);

  if (!oldMessages || oldMessages.length === 0) return;

  const dialogue = oldMessages
    .map((m) => `${m.role === "user" ? "用户" : "助手"}: ${m.content.slice(0, 500)}`)
    .join("\n");

  const prompt = [
    "请把【已有摘要】与【新增对话】合并压缩为一段结构化摘要：",
    "- 用户目标：用户在解决什么问题",
    "- 关键实体：涉及的文档名、专有名词、数据",
    "- 未解决问题：仍需继续追问或尚未答复的问题",
    "丢弃寒暄与重复内容，总输出不超过 200 字。",
    "",
    `【已有摘要】${session.summary ?? "（无）"}`,
    "",
    `【新增对话】\n${dialogue}`,
  ].join("\n");

  try {
    const response = await getChatModel().invoke([["human", prompt]]);
    const summary =
      typeof response.content === "string" ? response.content : JSON.stringify(response.content);
    const newUpto = total - RECENT_WINDOW;
    await db
      .from("sessions")
      .update({ summary: summary.slice(0, 1000), summarized_upto: newUpto })
      .eq("id", sessionId);
    console.log(`[memory] 会话 ${sessionId.slice(0, 8)} 摘要已更新（进度 ${newUpto}/${total}）`);
  } catch (err) {
    console.error("[memory] 摘要压缩失败（不影响本轮问答）:", err);
  }
}
