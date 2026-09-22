/**
 * 流式 Markdown 渲染辅助：
 * 查找最后一个未闭合的代码块围栏（```），渲染时裁掉未闭合围栏之后的内容，
 * 避免流式分片把代码块切成两半导致的渲染错乱与页面闪烁。
 *
 * 已知边界（记录在 DEV_LOG）：按 ``` 出现次数奇偶判断，围栏内出现的
 * 连续反引号（如代码内嵌 ``` ）会误判；更健壮的实现需要逐行状态机，
 * 对问答场景奇偶判断已足够。
 */
export function findLastOpenFence(text: string): number {
  const fences = text.match(/```/g) ?? [];
  if (fences.length % 2 === 0) return -1; // 全部闭合
  return text.lastIndexOf("```");
}

/** 返回可以安全渲染的文本（截掉未闭合围栏及其之后的内容） */
export function safeRenderText(text: string): string {
  const lastOpen = findLastOpenFence(text);
  return lastOpen === -1 ? text : text.slice(0, lastOpen);
}
