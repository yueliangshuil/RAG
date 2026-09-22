"use client";

import { useEffect, useMemo, useState } from "react";
import MarkdownIt from "markdown-it";
import DOMPurify from "isomorphic-dompurify";
import { safeRenderText } from "@/lib/markdown";

/**
 * 流式 Markdown 渲染（Phase 4）：
 * 1. 代码块缓冲：裁剪未闭合 ``` 围栏之后的内容，避免分片切半导致渲染错乱与闪烁，
 *    围栏闭合后内容自动追上；
 * 2. 节流渲染：流式期间最多每 80ms 更新一次渲染结果（trailing 语义），
 *    减少 re-render 与 DOM 解析次数，长回答下效果明显；
 * 3. XSS 清洗：模型输出视为不可信内容，markdown-it 渲染后统一过 DOMPurify。
 */
const md = new MarkdownIt({ html: true, linkify: true, breaks: true });
const RENDER_THROTTLE_MS = 80;

export default function MarkdownStream({ text }: { text: string }) {
  // 裁剪未闭合代码块后立即进入节流队列
  const safeText = useMemo(() => safeRenderText(text), [text]);
  const [renderText, setRenderText] = useState(safeText);

  useEffect(() => {
    const timer = setTimeout(() => setRenderText(safeText), RENDER_THROTTLE_MS);
    return () => clearTimeout(timer);
  }, [safeText]);

  const html = useMemo(
    () => DOMPurify.sanitize(md.render(renderText)),
    [renderText]
  );

  return (
    <div
      className="prose prose-sm dark:prose-invert max-w-none"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
