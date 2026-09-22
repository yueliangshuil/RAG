"use client";

import { useEffect, useRef, useState } from "react";
import Markdown from "./Markdown";
import type { Message } from "@/types/db";

interface Props {
  title: string;
  messages: Message[];
  input: string;
  sending: boolean;
  error: string | null;
  onInputChange: (value: string) => void;
  onSend: () => void;
}

export default function ChatMain({
  title,
  messages,
  input,
  sending,
  error,
  onInputChange,
  onSend,
}: Props) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, sending]);

  return (
    <main className="flex flex-1 flex-col overflow-hidden">
      {/* 标题栏 */}
      <header className="border-b border-zinc-200 bg-white px-6 py-3 dark:border-zinc-800 dark:bg-zinc-900">
        <h1 className="truncate text-sm font-medium">{title}</h1>
      </header>

      {/* 消息区 */}
      <div className="flex-1 overflow-y-auto px-6 py-4">
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
            <MessageBubble key={m.id} message={m} />
          ))}
          {sending && (
            <div className="flex items-center gap-2 text-sm text-zinc-400">
              <span className="h-2 w-2 animate-pulse rounded-full bg-zinc-400" />
              正在生成回答…
            </div>
          )}
          <div ref={bottomRef} />
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

function MessageBubble({ message }: { message: Message }) {
  const isUser = message.role === "user";
  const [showSources, setShowSources] = useState(false);

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
        ) : (
          <>
            <Markdown content={message.content} />
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
