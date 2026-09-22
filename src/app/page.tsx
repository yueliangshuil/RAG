"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import ChatSidebar from "@/components/ChatSidebar";
import ChatMain from "@/components/ChatMain";
import type { DocumentItem, Message, Session } from "@/types/db";

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

  const selectSession = async (id: string) => {
    setCurrentId(id);
    setError(null);
    const res = await fetch(`/api/sessions/${id}/messages`);
    if (res.ok) {
      const data = await res.json();
      setMessages(data.messages);
    }
  };

  const newSession = () => {
    setCurrentId(null);
    setMessages([]);
    setError(null);
  };

  const deleteSession = async (id: string) => {
    const res = await fetch(`/api/sessions/${id}`, { method: "DELETE" });
    if (res.ok) {
      if (id === currentId) {
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
      setMessages((prev) => [...prev, data.message]);
      await refreshSessions();
    } catch (e) {
      setError(e instanceof Error ? e.message : "发送失败");
      setInput(content);
      setMessages((prev) => prev.filter((m) => m.id !== localUserMsg.id));
    } finally {
      setSending(false);
    }
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

  const currentTitle =
    sessions.find((s) => s.id === currentId)?.title ?? "新对话";

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
      />
    </div>
  );
}
