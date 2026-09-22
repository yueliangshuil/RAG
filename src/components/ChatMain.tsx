"use client";

import { useEffect, useRef, useState } from "react";
import Markdown from "./Markdown";
import MarkdownStream from "./MarkdownStream";
import type { Message } from "@/types/db";

interface Props {
  title: string;
  messages: Message[];
  input: string;
  sending: boolean;
  error: string | null;
  onInputChange: (value: string) => void;
  onSend: () => void;
  onContinue: (messageId: string) => void;
}

export default function ChatMain({
  title,
  messages,
  input,
  sending,
  error,
  onInputChange,
  onSend,
  onContinue,
}: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  // 自动滚动：仅当用户停留在底部附近时跟随，用户上翻查看时暂停
  const stickToBottomRef = useRef(true);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (stickToBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages]);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  return (
    <main className="flex flex-1 flex-col overflow-hidden">
      {/* 标题栏 */}
      <header className="border-b border-zinc-200 bg-white px-6 py-3 dark:border-zinc-800 dark:bg-zinc-900">
        <h1 className="truncate text-sm font-medium">{title}</h1>
      </header>

      {/* 消息区 */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto px-6 py-4"
      >
        <div className="mx-auto max-w-3xl space-y-6">
          {messages.length === 0 && (
            <div className="flex h-full flex-col items-center justify-center pt-24 text-center">
              <p className="text-lg font-medium">智能文档检索与问答平台</p>
              <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">
                先在左侧上传知识库文档，然后开始提问
              </p>
            </div>
          )}
          {messages.map((m) => (
            <MessageBubble key={m.id} message={m} onContinue={onContinue} />
          ))}
          {sending && (
            <div className="flex items-center gap-2 text-sm text-zinc-400">
              <span className="h-2 w-2 animate-pulse rounded-full bg-zinc-400" />
              正在准备…
            </div>
          )}
        </div>
      </div>

      {/* 错误提示 */}
      {error && (
        <div className="mx-auto max-w-3xl px-6 pb-2">
          <p className="rounded-lg bg-red-50 px-4 py-2 text-sm text-red-600 dark:bg-red-950/40 dark:text-red-400">
            {error}
          </p>
        </div>
      )}

      {/* 输入区 */}
      <div className="border-t border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
        <div className="mx-auto flex max-w-3xl items-end gap-3">
          <textarea
            value={input}
            onChange={(e) => onInputChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                onSend();
              }
            }}
            rows={Math.min(6, Math.max(1, input.split("\n").length))}
            placeholder="输入问题，Enter 发送，Shift+Enter 换行"
            className="max-h-40 flex-1 resize-none rounded-xl border border-zinc-300 bg-white px-4 py-3 text-sm outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-800"
          />
          <button
            onClick={onSend}
            disabled={sending || !input.trim()}
            className="rounded-xl bg-zinc-900 px-5 py-3 text-sm font-medium text-white transition-colors hover:bg-zinc-700 disabled:opacity-40 dark:bg-zinc-100 dark:text-zinc-900"
          >
            发送
          </button>
        </div>
      </div>
    </main>
  );
}

function MessageBubble({
  message,
  onContinue,
}: {
  message: Message;
  onContinue: (messageId: string) => void;
}) {
  const isUser = message.role === "user";
  const [showSources, setShowSources] = useState(false);
  const generating = message.status === "generating";

  return (
    <div className={isUser ? "flex justify-end" : "flex justify-start"}>
      <div
        className={`max-w-[85%] rounded-2xl px-4 py-3 ${
          isUser
            ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
            : "bg-white border border-zinc-200 dark:bg-zinc-900 dark:border-zinc-800"
        }`}
      >
        {isUser ? (
          <p className="whitespace-pre-wrap text-sm">{message.content}</p>
        ) : generating ? (
          <StreamingContent message={message} />
        ) : (
          <>
            <Markdown content={message.content} />
            {message.status === "interrupted" && (
              <div className="mt-3 rounded-lg bg-amber-50 p-3 dark:bg-amber-950/30">
                <p className="text-xs text-amber-700 dark:text-amber-400">
                  ⚠️ 生成中断：{message.error ?? "未知原因"}
                </p>
                <button
                  onClick={() => onContinue(message.id)}
                  className="mt-2 rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-amber-500"
                >
                  继续生成
                </button>
              </div>
            )}
            {message.sources && message.sources.length > 0 && (
              <div className="mt-3 border-t border-zinc-200 pt-2 dark:border-zinc-700">
                <button
                  onClick={() => setShowSources((v) => !v)}
                  className="text-xs text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300"
                >
                  📎 引用来源（{message.sources.length}）{showSources ? "▲" : "▼"}
                </button>
                {showSources && (
                  <ul className="mt-2 space-y-2">
                    {message.sources.map((s, i) => (
                      <li
                        key={i}
                        className="rounded-lg bg-zinc-50 p-2 text-xs text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300"
                      >
                        <p className="mb-1 font-medium">
                          [{i + 1}] 《{s.filename}》 · 相似度 {s.similarity.toFixed(3)}
                        </p>
                        <p className="line-clamp-3">{s.content}</p>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/** 生成中的流式内容：阶段反馈（检索中/思考中）→ 增量渲染 → 卡顿提示 */
function StreamingContent({ message }: { message: Message }) {
  if (message.content === "") {
    const label =
      message.stage === "thinking"
        ? "正在思考…"
        : message.slowNotice
          ? "模型响应较慢，请稍候…"
          : "正在检索知识库…";
    return (
      <div className="flex items-center gap-2 py-1 text-sm text-zinc-400">
        <span className="h-2 w-2 animate-pulse rounded-full bg-zinc-400" />
        {label}
      </div>
    );
  }
  return (
    <>
      <MarkdownStream text={message.content} />
      {message.slowNotice && (
        <p className="mt-2 text-xs text-zinc-400">模型响应较慢，继续生成中…</p>
      )}
      <span className="mt-1 inline-block h-3 w-2 animate-pulse bg-zinc-400" />
    </>
  );
}
