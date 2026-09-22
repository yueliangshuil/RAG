"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import ChatSidebar from "@/components/ChatSidebar";
import ChatMain from "@/components/ChatMain";
import { parseSSEBlock } from "@/lib/sse";
import type { DocumentItem, Message, Session } from "@/types/db";

const MAX_RECONNECT = 3; // 断线重连上限（超限标记 interrupted，可手动继续生成）

export default function Home() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [documents, setDocuments] = useState<DocumentItem[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loadedRef = useRef(false);
  const streamControllers = useRef(new Map<string, AbortController>());

  const refreshSessions = useCallback(async () => {
    const res = await fetch("/api/sessions");
    if (res.ok) {
      const data = await res.json();
      setSessions(data.sessions);
    }
  }, []);

  const refreshDocuments = useCallback(async () => {
    const res = await fetch("/api/documents");
    if (res.ok) {
      const data = await res.json();
      setDocuments(data.documents);
    }
  }, []);

  useEffect(() => {
    if (loadedRef.current) return;
    loadedRef.current = true;
    refreshSessions();
    refreshDocuments();
  }, [refreshSessions, refreshDocuments]);

  /** 更新单条消息（函数式 patch 支持基于旧值的追加） */
  const patchMessage = useCallback(
    (messageId: string, patch: Partial<Message> | ((m: Message) => Message)) => {
      setMessages((prev) =>
        prev.map((m) =>
          m.id === messageId
            ? typeof patch === "function"
              ? patch(m)
              : { ...m, ...patch }
            : m
        )
      );
    },
    []
  );

  /** 取消所有活跃的流连接（切换会话/新建会话时主动取消无效请求） */
  const abortAllStreams = useCallback(() => {
    for (const ctrl of streamControllers.current.values()) {
      ctrl.abort();
    }
    streamControllers.current.clear();
  }, []);

  /**
   * SSE 断点续流连接：
   * - from = 已收到的累计字符数，服务端按偏移补发，天然去重；
   * - 网络断开自动重连（指数退避，最多 3 次）；
   * - 页面刷新后对 generating 消息重新挂接，后台生成任务不受影响。
   */
  const connectStream = useCallback(
    (messageId: string, initialFrom: number) => {
      let from = initialFrom;
      let retries = 0;
      let finished = false;
      const controller = new AbortController();
      streamControllers.current.set(messageId, controller);

      const update = (patch: Partial<Message> | ((m: Message) => Message)) => {
        if (!finished) patchMessage(messageId, patch);
      };

      const run = async () => {
        let slowTimer: ReturnType<typeof setInterval> | null = null;
        try {
          const res = await fetch(`/api/messages/${messageId}/stream?from=${from}`, {
            signal: controller.signal,
          });
          if (!res.ok || !res.body) {
            throw new Error(`连接失败: ${res.status}`);
          }

          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";
          let lastEventAt = Date.now();

          // 模型卡顿检测：20s 无任何事件 → 提示"响应较慢"（不中断连接）
          slowTimer = setInterval(() => {
            if (Date.now() - lastEventAt > 20_000) {
              update({ slowNotice: true });
            }
          }, 5_000);

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
              lastEventAt = Date.now();
              if (ev.event === "delta") {
                update((m) => ({ ...m, content: m.content + ev.data, slowNotice: false }));
                from = ev.id;
              } else if (ev.event === "stage") {
                update({ stage: ev.data, slowNotice: false });
              } else if (ev.event === "done") {
                finished = true;
                update({ status: "done", stage: undefined });
                return;
              } else if (ev.event === "interrupted") {
                finished = true;
                const info = JSON.parse(ev.data);
                update({
                  status: "interrupted",
                  error: info.error ?? "生成中断",
                  stage: undefined,
                });
                return;
              }
              // ping：仅心跳，忽略
            }
          }
          // 流意外结束但未收到 done → 按断线处理
          throw new Error("连接意外中断");
        } catch (err) {
          if (controller.signal.aborted) return; // 主动取消，不重连
          retries++;
          if (retries <= MAX_RECONNECT) {
            setTimeout(() => {
              if (!controller.signal.aborted && !finished) run();
            }, 1_500 * retries);
          } else {
            update({
              status: "interrupted",
              error: "连接中断，可点击「继续生成」恢复",
            });
          }
        } finally {
          if (slowTimer) clearInterval(slowTimer);
        }
      };

      void run();

      const cleanup = () => {
        finished = true;
        controller.abort();
        streamControllers.current.delete(messageId);
      };
      return cleanup;
    },
    [patchMessage]
  );

  const selectSession = async (id: string) => {
    abortAllStreams();
    setCurrentId(id);
    setError(null);
    const res = await fetch(`/api/sessions/${id}/messages`);
    if (res.ok) {
      const data = await res.json();
      setMessages(data.messages);
      // 刷新续聊：生成中的消息重新挂接流；中断的消息由 UI 提供继续按钮
      for (const m of data.messages as Message[]) {
        if (m.status === "generating") {
          connectStream(m.id, m.content.length);
        }
      }
    }
  };

  const newSession = () => {
    abortAllStreams();
    setCurrentId(null);
    setMessages([]);
    setError(null);
  };

  const deleteSession = async (id: string) => {
    const res = await fetch(`/api/sessions/${id}`, { method: "DELETE" });
    if (res.ok) {
      if (id === currentId) {
        abortAllStreams();
        setCurrentId(null);
        setMessages([]);
      }
      await refreshSessions();
    }
  };

  /** 没有当前会话时先创建（返回可用 id） */
  const ensureSession = async (): Promise<string | null> => {
    if (currentId) return currentId;
    const res = await fetch("/api/sessions", { method: "POST" });
    if (!res.ok) return null;
    const data = await res.json();
    await refreshSessions();
    setCurrentId(data.session.id);
    return data.session.id as string;
  };

  const send = async () => {
    const content = input.trim();
    if (!content || sending) return;
    const id = await ensureSession();
    if (!id) {
      setError("创建会话失败，请重试");
      return;
    }
    setSending(true);
    setError(null);
    setInput("");
    const localUserMsg: Message = {
      id: `local-${Date.now()}`,
      session_id: id,
      role: "user",
      content,
      sources: null,
      status: "done",
      error: null,
      created_at: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, localUserMsg]);
    try {
      const res = await fetch(`/api/sessions/${id}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "请求失败");
      setMessages((prev) => prev.map((m) => (m.id === localUserMsg.id ? data.userMessage : m)));
      if (data.emptyKnowledgeBase) {
        setMessages((prev) => [...prev, data.message]);
      } else {
        setMessages((prev) => [...prev, data.assistantMessage]);
        connectStream(data.assistantMessage.id, 0);
      }
      await refreshSessions();
    } catch (e) {
      setError(e instanceof Error ? e.message : "发送失败");
      setInput(content);
      setMessages((prev) => prev.filter((m) => m.id !== localUserMsg.id));
    } finally {
      setSending(false);
    }
  };

  /** 继续生成：中断的消息从断点续跑，重新挂接流 */
  const continueMessage = async (messageId: string) => {
    const m = messages.find((x) => x.id === messageId);
    if (!m) return;
    const res = await fetch(`/api/messages/${messageId}/continue`, { method: "POST" });
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      setError(data?.error ?? "继续生成失败");
      return;
    }
    patchMessage(messageId, { status: "generating", error: null });
    connectStream(messageId, m.content.length);
  };

  const upload = async (file: File) => {
    setUploading(true);
    setError(null);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch("/api/documents", { method: "POST", body: formData });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "上传失败");
      await refreshDocuments();
      if (data.duplicated) {
        setError(`《${file.name}》已存在，已自动跳过`);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "上传失败");
    } finally {
      setUploading(false);
    }
  };

  const deleteDocument = async (id: string) => {
    const res = await fetch(`/api/documents/${id}`, { method: "DELETE" });
    if (res.ok) await refreshDocuments();
  };

  const currentTitle = sessions.find((s) => s.id === currentId)?.title ?? "新对话";

  return (
    <div className="flex h-screen overflow-hidden bg-zinc-50 font-sans dark:bg-zinc-950">
      <ChatSidebar
        sessions={sessions}
        currentId={currentId}
        documents={documents}
        uploading={uploading}
        onSelect={selectSession}
        onNew={newSession}
        onDeleteSession={deleteSession}
        onUpload={upload}
        onDeleteDocument={deleteDocument}
      />
      <ChatMain
        title={currentTitle}
        messages={messages}
        input={input}
        sending={sending}
        error={error}
        onInputChange={setInput}
        onSend={send}
        onContinue={continueMessage}
      />
    </div>
  );
}
