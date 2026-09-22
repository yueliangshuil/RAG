/**
 * 中文 bigram 分词器（BM25 关键词检索用）
 *
 * 背景：Postgres 默认 FTS 不支持中文分词（整段中文会被当成一个 token），
 * Supabase 又无法安装 zhparser/pg_bigm 扩展。
 * 方案：应用层对中文做 bigram（相邻两字一组）切分，英文/数字按单词提取，
 * 生成空格分隔的 token 串存入 tsvector，配合 GIN 索引做关键词检索。
 *
 * 示例：
 *   "员工请假需提前一天" → "员工 工请 请假 假需 需提 提前 前一 一天"
 *   "ThinkPad T16 或 MacBook" → "thinkpad t16 macbook"
 */
const CJK_RE = /[一-鿿]/;
const LATIN_RE = /[a-zA-Z0-9]/;

export function bigramTokenize(text: string): string[] {
  const tokens: string[] = [];
  let word = "";
  let prevCjk = "";

  const flushWord = () => {
    if (word) {
      tokens.push(word.toLowerCase());
      word = "";
    }
  };

  for (const ch of text) {
    if (LATIN_RE.test(ch)) {
      // 连续拉丁字符聚成单词（英文/型号/缩写等）
      word += ch;
      prevCjk = "";
      continue;
    }
    flushWord();
    if (CJK_RE.test(ch)) {
      // 仅保留相邻两汉字组成的 bigram；
      // 不做单字 unigram：孤立单字多为噪声，会稀释 BM25 得分（单字查询由向量检索兜底）
      if (prevCjk) {
        tokens.push(prevCjk + ch);
      }
      prevCjk = ch;
    } else {
      prevCjk = "";
    }
  }
  flushWord();

  // 去重保序（tsvector 本身会去重，这里提前去掉省空间）
  return [...new Set(tokens)];
}

/** 生成 tsquery 字符串（OR 语义，匹配越多得分越高） */
export function buildTsQuery(text: string): string {
  const tokens = bigramTokenize(text);
  return tokens.map((t) => `'${t}'`).join(" | ");
}
