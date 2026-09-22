"use client";

import { useMemo } from "react";
import MarkdownIt from "markdown-it";
import DOMPurify from "isomorphic-dompurify";

/**
 * Markdown 渲染（markdown-it + DOMPurify）
 * - 模型输出视为不可信内容，渲染前统一 XSS 清洗
 * - Phase 4 会在此基础上实现流式增量渲染（代码块缓冲 + 节流）
 */
const md = new MarkdownIt({
  html: true, // 允许内嵌 HTML，由 DOMPurify 兜底过滤
  linkify: true,
  breaks: true, // GFM 行为：换行即 <br>
});

export default function Markdown({ content }: { content: string }) {
  const html = useMemo(() => {
    const raw = md.render(content);
    return DOMPurify.sanitize(raw);
  }, [content]);

  return (
    <div
      className="prose prose-sm dark:prose-invert max-w-none"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
