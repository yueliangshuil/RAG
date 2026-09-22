import { test } from "node:test";
import assert from "node:assert/strict";
import { bigramTokenize, buildTsQuery } from "./tokenizer";

test("中文连续串切分为相邻二字 bigram", () => {
  assert.deepEqual(bigramTokenize("员工请假"), ["员工", "工请", "请假"]);
});

test("英文与数字按单词提取并转小写", () => {
  assert.deepEqual(bigramTokenize("ThinkPad T16 或 MacBook"), [
    "thinkpad",
    "t16",
    "macbook",
  ]);
});

test("中英混合：单词与汉字分别处理", () => {
  assert.deepEqual(bigramTokenize("OA系统"), ["oa", "系统"]);
});

test("标点分割汉字序列，各自生成 bigram", () => {
  const tokens = bigramTokenize("年假。病假");
  assert.ok(tokens.includes("年假"));
  assert.ok(tokens.includes("病假"));
  assert.ok(!tokens.includes("病")); // 不做单字 unigram
});

test("重复 bigram 去重", () => {
  assert.deepEqual(bigramTokenize("你好你好"), ["你好", "好你"]);
});

test("空字符串返回空数组", () => {
  assert.deepEqual(bigramTokenize(""), []);
});

test("buildTsQuery 生成 OR 语义的 tsquery", () => {
  const q = buildTsQuery("请假");
  assert.equal(q, "'请假'");
  const q2 = buildTsQuery("年假 报销");
  assert.ok(q2.includes("'年假' | '报销'"));
});
