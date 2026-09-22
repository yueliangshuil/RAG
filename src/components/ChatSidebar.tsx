"use client";

import { useRef } from "react";
import type { DocumentItem, Session } from "@/types/db";

interface Props {
  sessions: Session[];
  currentId: string | null;
  documents: DocumentItem[];
  uploading: boolean;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDeleteSession: (id: string) => void;
  onUpload: (file: File) => void;
  onDeleteDocument: (id: string) => void;
}

export default function ChatSidebar({
  sessions,
  currentId,
  documents,
  uploading,
  onSelect,
  onNew,
  onDeleteSession,
  onUpload,
  onDeleteDocument,
}: Props) {
  const fileInputRef = useRef<HTMLInputElement>(null);

  return (
    <aside className="flex w-72 shrink-0 flex-col border-r border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
      {/* 顶部：新建会话 */}
      <div className="p-3">
        <button
          onClick={onNew}
          className="w-full rounded-lg bg-zinc-900 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white"
        >
          + 新对话
        </button>
      </div>

      {/* 会话列表 */}
      <nav className="flex-1 overflow-y-auto px-3">
        <p className="px-1 pb-2 text-xs text-zinc-400">会话</p>
        <ul className="space-y-1">
          {sessions.map((s) => (
            <li key={s.id} className="group flex items-center gap-1">
              <button
                onClick={() => onSelect(s.id)}
                className={`flex-1 truncate rounded-lg px-3 py-2 text-left text-sm transition-colors ${
                  s.id === currentId
                    ? "bg-zinc-100 dark:bg-zinc-800"
                    : "hover:bg-zinc-50 dark:hover:bg-zinc-800/60"
                }`}
              >
                {s.title}
              </button>
              <button
                onClick={() => onDeleteSession(s.id)}
                title="删除会话"
                className="hidden rounded p-1 text-zinc-400 hover:text-red-500 group-hover:block"
              >
                ✕
              </button>
            </li>
          ))}
          {sessions.length === 0 && (
            <li className="px-3 py-2 text-sm text-zinc-400">暂无会话</li>
          )}
        </ul>
      </nav>

      {/* 文档管理 */}
      <div className="border-t border-zinc-200 p-3 dark:border-zinc-800">
        <div className="flex items-center justify-between pb-2">
          <p className="text-xs text-zinc-400">知识库文档（{documents.length}）</p>
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
            className="rounded bg-zinc-100 px-2 py-1 text-xs font-medium hover:bg-zinc-200 disabled:opacity-50 dark:bg-zinc-800 dark:hover:bg-zinc-700"
          >
            {uploading ? "解析中…" : "上传"}
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".pdf,.md,.markdown,.txt"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) onUpload(file);
              e.target.value = "";
            }}
          />
        </div>
        <ul className="max-h-40 space-y-1 overflow-y-auto">
          {documents.map((d) => (
            <li key={d.id} className="group flex items-center gap-1">
              <span
                title={d.filename}
                className="flex-1 truncate text-sm text-zinc-600 dark:text-zinc-300"
              >
                {d.filename}
              </span>
              <span className="shrink-0 text-xs text-zinc-400">{d.chunk_count} 块</span>
              <button
                onClick={() => onDeleteDocument(d.id)}
                title="删除文档"
                className="hidden rounded p-1 text-zinc-400 hover:text-red-500 group-hover:block"
              >
                ✕
              </button>
            </li>
          ))}
          {documents.length === 0 && (
            <li className="text-xs text-zinc-400">尚未上传文档</li>
          )}
        </ul>
      </div>
    </aside>
  );
}
