import { test } from "node:test";
import assert from "node:assert/strict";
import { debounce } from "./debounce";
import { findLastOpenFence, safeRenderText } from "./markdown";
import { encodeSSE, parseSSEBlock } from "./sse";

// ---------- 防抖（服务端落库） ----------

test("debounce：连续调用只执行最后一次（trailing）", async () => {
  const calls: string[] = [];
  const fn = debounce((v: string) => calls.push(v), 50);
  fn("a");
  fn("b");
  fn("c");
  await new Promise((r) => setTimeout(r, 80));
  assert.deepEqual(calls, ["c"]);
});

test("debounce.flush：立即执行并取消等待中的调用", async () => {
  const calls: string[] = [];
  const fn = debounce((v: string) => calls.push(v), 50);
  fn("a");
  fn.flush("b");
  await new Promise((r) => setTimeout(r, 80));
  assert.deepEqual(calls, ["b"]);
});

// ---------- 代码块缓冲（前端渲染防错乱） ----------

test("findLastOpenFence：无围栏返回 -1", () => {
  assert.equal(findLastOpenFence("普通文本"), -1);
});

test("findLastOpenFence：闭合围栏返回 -1", () => {
  assert.equal(findLastOpenFence("```ts\ncode\n```\n文字"), -1);
});

test("findLastOpenFence：未闭合围栏返回其起始下标", () => {
  const text = "前文\n```python\nprint(1)\n";
  assert.equal(findLastOpenFence(text), text.lastIndexOf("```"));
});

test("safeRenderText：裁剪未闭合围栏及其后内容，闭合后追齐", () => {
  const partial = "前文\n```python\nprint(1)\n";
  assert.equal(safeRenderText(partial), "前文\n");
  const closed = partial + "```\n尾注";
  assert.equal(safeRenderText(closed), closed);
});

// ---------- SSE 协议 ----------

test("parseSSEBlock：解析 id/event/data", () => {
  const ev = parseSSEBlock("id: 42\nevent: delta\ndata: 你好\n");
  assert.deepEqual(ev, { id: 42, event: "delta", data: "你好" });
});

test("parseSSEBlock：多行 data 合并，缺省 event 为 message", () => {
  const ev = parseSSEBlock("id: 7\ndata: 第一行\ndata: 第二行\n");
  assert.equal(ev?.event, "message");
  assert.equal(ev?.data, "第一行\n第二行");
});

test("parseSSEBlock：仅注释（无 data）返回 null", () => {
  assert.equal(parseSSEBlock(": ping\n"), null);
});

test("encodeSSE 与 parseSSEBlock 往返一致", () => {
  const frame = encodeSSE(10, "done", '{"status":"done"}');
  const ev = parseSSEBlock(frame);
  assert.equal(ev?.id, 10);
  assert.equal(ev?.event, "done");
  assert.equal(ev?.data, '{"status":"done"}');
});

test("encodeSSE：data 内换行逐行加前缀，往返不丢内容（回归测试）", () => {
  const data = "第一行\n第二行\n\n空行后内容";
  const ev = parseSSEBlock(encodeSSE(5, "delta", data));
  assert.equal(ev?.data, data);
});

test("parseSSEBlock：仅去掉一个分隔空格，保留内容前导空格（回归测试）", () => {
  const ev = parseSSEBlock(encodeSSE(8, "delta", "  - 列表项（两个前导空格）\n第二行"));
  assert.equal(ev?.data, "  - 列表项（两个前导空格）\n第二行");
});
