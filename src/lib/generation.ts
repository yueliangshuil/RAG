import { getSupabaseAdmin } from "./supabase";
import { getChatModel, getEmbeddings } from "./llm";
import { getTopK } from "./env";
import { buildTsQuery } from "./tokenizer";
import { maybeSummarize, RECENT_WINDOW, saveMessageMemory, searchMessageMemories } from "./memory";
import { debounce } from "./debounce";
import type { SourceRef } from "@/types/db";

/**
 * Phase 3 核心：后台生成引擎 + 流缓冲注册表
 *
 * 架构要点（断点续流）：
 * - POST /chat 只落库两条消息并立即返回，生成任务在后台运行（不随客户端断开而停止）；
 * - 每个消息维护一个内存流缓冲（chunks + 订阅者），客户端刷新后按消息 ID 重新挂接，
 *   以字符偏移（from）断点续收，天然去重；
 * - 内容防抖落库（500ms），流结束 flush 后置状态 done；异常置 interrupted 并保留已生成部分，
 *   可通过 /continue 从断点继续生成；
 * - 检索三级降级：混合检索 → 纯向量 → 无检索降级回答（附系统说明），保证知识库故障时
 *   用户仍有可用回答而不是报错。
 *
 * 已知限制（记录于 DEV_LOG）：内存缓冲仅适用于单实例（本地 dev）；
 * Vercel serverless 无共享内存/后台任务，部署阶段需将缓冲持久化或引入队列，
 * 当前实现已保证 serverless 下优雅降级（缓冲丢失 → interrupted → 继续生成）。
 */

interface StreamBuffer {
  chunks: string[];
  subscribers: Set<(chunk: string, cumulative: number) => void>;
  stageListeners: Set<(stage: string) => void>;
  onDone: Set<(cumulative: number) => void>;
  onInterrupted: Set<(reason: string, cumulative: number) => void>;
  total: number;
  /** 任务取消信号：客户端断开且无订阅者（宽限期后）时触发 */
  cancelController: AbortController;
  cancelTimer: ReturnType<typeof setTimeout> | null;
  done: boolean;
  failed: boolean;
}

/** 取消宽限期：客户端断开后，若期间有新订阅者接入（页面刷新重连），撤销取消 */
export const CANCEL_GRACE_MS = 5_000;

const buffers = new Map<string, StreamBuffer>();

export function getBuffer(messageId: string): StreamBuffer | undefined {
  return buffers.get(messageId);
}

export interface GenerationInput {
  sessionId: string;
  messageId: string;
  question: string;
  /** 断点续生成：已生成的部分内容（/continue 场景） */
  continueFrom?: string;
}

export async function startGeneration(input: GenerationInput): Promise<void> {
  const { sessionId, messageId, question, continueFrom } = input;
  const db = getSupabaseAdmin();

  const buf: StreamBuffer = {
    chunks: [],
    subscribers: new Set(),
    stageListeners: new Set(),
    onDone: new Set(),
    onInterrupted: new Set(),
    total: continueFrom?.length ?? 0,
    cancelController: new AbortController(),
    cancelTimer: null,
    done: false,
    failed: false,
  };
  buffers.set(messageId, buf);

  const notifyStage = (stage: string) => {
    for (const l of buf.stageListeners) l(stage);
  };

  // 防抖落库：静默 500ms 才写一次 DB，流结束 flush
  const persist = debounce(async (text: string) => {
    await db.from("messages").update({ content: text }).eq("id", messageId);
  }, 500);

  let fullContent = continueFrom ?? "";

  try {
    // ========== 1. 检索（三级降级：混合 → 向量 → 无检索） ==========
    let sources: SourceRef[] = [];
    let retrievalNote = "";
    try {
      const queryVector = await getEmbeddings().embedQuery(question);
      try {
        // 一级：BM25 + 向量混合检索（RRF）
        const tsquery = buildTsQuery(question);
        if (tsquery.trim() !== "") {
          const { data, error } = await db.rpc("hybrid_search", {
            query_embedding: JSON.stringify(queryVector),
            query_tsquery: tsquery,
            match_count: getTopK(),
          });
          if (error) throw new Error(error.message);
          sources = await attachFilenames(data as RetrievedChunk[]);
        } else {
          throw new Error("query 无可分词 token");
        }
      } catch (hybridErr) {
        // 二级：纯向量检索
        console.warn(`[generation] 混合检索失败，降级为向量检索: ${hybridErr}`);
        try {
          const { data, error } = await db.rpc("match_chunks", {
            query_embedding: JSON.stringify(queryVector),
            match_count: getTopK(),
          });
          if (error) throw new Error(error.message);
          sources = await attachFilenames(data as RetrievedChunk[]);
        } catch (vectorErr) {
          // 三级：无检索降级
          console.error(`[generation] 向量检索也失败，降级为无检索模式: ${vectorErr}`);
          retrievalNote = "知识库检索服务当前不可用";
        }
      }
    } catch (embedErr) {
      // Embedding API 失败同样走无检索降级
      console.error(`[generation] Embedding 失败，降级为无检索模式: ${embedErr}`);
      retrievalNote = "知识库检索服务当前不可用";
    }

    // ========== 2. 近期窗口历史 + 向量记忆 + 滚动摘要 ==========
    const { data: session } = await db.from("sessions").select("*").eq("id", sessionId).single();
    const { data: history } = await db
      .from("messages")
      .select("*")
      .eq("session_id", sessionId)
      .order("created_at", { ascending: false })
      .limit(RECENT_WINDOW);
    const recentHistory = (history ?? []).reverse().filter((m) => m.id !== messageId);

    let memories: { role: string; content: string }[] = [];
    try {
      const qv = await getEmbeddings().embedQuery(question);
      memories = await searchMessageMemories(
        sessionId,
        qv,
        [messageId, ...recentHistory.map((m) => m.id)]
      );
    } catch (err) {
      console.warn("[generation] 记忆检索失败（不影响主流程）:", err);
    }

    // ========== 3. 组装提示词 ==========
    const contextText = sources
      .map((s, i) => `[${i + 1}] (来自《${s.filename}》) ${s.content}`)
      .join("\n\n");
    const memoryText = memories
      .map((m, i) => `【记忆${i + 1}】${m.role === "user" ? "用户曾问" : "此前回答"}: ${m.content.slice(0, 300)}`)
      .join("\n");

    const systemPrompt = [
      "你是「智能文档检索与问答平台」的知识库助手。",
      "回答规则：",
      "1. 优先依据【检索片段】作答，引用处标注片段编号（如 [1]）；",
      "2. 可参考【历史摘要】与【相关历史记忆】理解多轮对话上下文；",
      "3. 检索片段不足时，明确说明「知识库中未找到相关内容」，不得编造；",
      "4. 回答使用 Markdown 格式，代码用代码块包裹。",
      retrievalNote ? `5. 【重要】${retrievalNote}，请向用户说明该情况，并基于历史对话尽力回答。` : "",
      "",
      `【历史摘要】${session?.summary ?? "（无）"}`,
      "",
      `【相关历史记忆】\n${memoryText || "（无）"}`,
      "",
      `【检索片段】\n${contextText || "（无相关片段）"}`,
      continueFrom ? "\n【续写指令】上一轮回答因服务中断未完成，请从已生成内容的结尾继续完整输出剩余部分，不要重复已生成的内容。" : "",
    ].join("\n");

    const messages: [string, string][] = [
      ["system", systemPrompt],
      ...recentHistory.map((m) => [m.role, m.content] as [string, string]),
      ["human", question],
      ...(continueFrom ? [["assistant", continueFrom] as [string, string]] : []),
    ];

    // ========== 4. 流式生成（模型卡顿期间由 SSE 心跳 + 客户端计时器反馈） ==========
    notifyStage("thinking");
    const stream = await getChatModel().stream(messages, {
      signal: buf.cancelController.signal,
    });
    for await (const chunk of stream) {
      // 双保险：切换问题等场景触发取消后立即停止消费
      if (buf.cancelController.signal.aborted) {
        throw new Error("生成已取消");
      }
      const piece = typeof chunk.content === "string" ? chunk.content : "";
      if (!piece) continue;
      buf.total += piece.length;
      buf.chunks.push(piece);
      for (const sub of buf.subscribers) sub(piece, buf.total);
      fullContent += piece;
      persist(fullContent);
    }

    // ========== 5. 完成落库 ==========
    persist.flush(fullContent);
    await db.from("messages").update({ content: fullContent, status: "done", sources }).eq("id", messageId);
    buf.done = true;
    for (const d of buf.onDone) d(buf.total);

    void saveMessageMemory(sessionId, messageId, "assistant", fullContent);
    void maybeSummarize(sessionId);
  } catch (err) {
    // ========== 异常/取消：保留已生成部分，标记 interrupted ==========
    const reason = err instanceof Error ? err.message : "生成失败";
    console.error(`[generation] 消息 ${messageId.slice(0, 8)} 生成失败:`, reason);
    if (fullContent) {
      persist.flush(fullContent);
      await db.from("messages").update({ content: fullContent, status: "interrupted", error: reason }).eq("id", messageId);
    } else {
      await db.from("messages").update({ status: "interrupted", error: reason }).eq("id", messageId);
    }
    buf.failed = true;
    for (const i of buf.onInterrupted) i(reason, buf.total);
  } finally {
    if (buf.cancelTimer) clearTimeout(buf.cancelTimer);
    buffers.delete(messageId);
  }
}

// ---------- 辅助 ----------

interface RetrievedChunk {
  document_id: string;
  content: string;
  similarity: number;
}

async function attachFilenames(chunks: RetrievedChunk[]): Promise<SourceRef[]> {
  if (!chunks.length) return [];
  const db = getSupabaseAdmin();
  const docIds = [...new Set(chunks.map((c) => c.document_id))];
  const { data: docs } = await db.from("documents").select("id, filename").in("id", docIds);
  const filenameMap = new Map((docs ?? []).map((d) => [d.id, d.filename]));
  return chunks.map((c) => ({
    document_id: c.document_id,
    filename: filenameMap.get(c.document_id) ?? "未知文档",
    content: c.content,
    similarity: c.similarity,
  }));
}
