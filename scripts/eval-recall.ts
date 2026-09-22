/**
 * 召回率评测：向量检索 vs BM25+向量混合检索（RRF）
 * 运行：pnpm tsx scripts/eval-recall.ts
 * 输出：docs/eval-results.md（含每条 query 的命中详情与汇总数据）
 */
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { OpenAIEmbeddings } from "@langchain/openai";
import { ingestDocument } from "../src/lib/rag";
import { buildTsQuery } from "../src/lib/tokenizer";

// ---------- 环境加载 ----------
function loadEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of readFileSync(".env.local", "utf-8").split("\n")) {
    const idx = line.indexOf("=");
    if (idx > 0 && !line.trim().startsWith("#")) {
      env[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    }
  }
  Object.assign(process.env, env);
  return env;
}

// ---------- 评测集：query 与正确答案所在文档 ----------
const CORPUS_DIR = join(process.cwd(), "scripts", "eval-corpus");

/**
 * 评测集约定：query 的正确答案标注为目标文档（模拟多租户知识库中"本公司的规定"），
 * 干扰文档中同主题的其他规定均视为错误命中。评测规模为实习项目级别，
 * 用于对比纯向量与混合检索的相对提升，不代表生产效果。
 */
const QUERIES: { q: string; relevant: string; type: string }[] = [
  // ===== 云舟科技员工手册（15 条）=====
  { q: "员工请假需要提前多久申请？", relevant: "云舟科技员工手册.md", type: "歧义通用词" },
  { q: "请假怎么申请？", relevant: "云舟科技员工手册.md", type: "歧义通用词" },
  { q: "年假有多少天？", relevant: "云舟科技员工手册.md", type: "歧义通用词" },
  { q: "年假可以拆分使用吗？", relevant: "云舟科技员工手册.md", type: "歧义通用词" },
  { q: "报销超过多少需要部门经理加签？", relevant: "云舟科技员工手册.md", type: "歧义通用词" },
  { q: "发票抬头是什么？", relevant: "云舟科技员工手册.md", type: "歧义通用词" },
  { q: "密码需要多久更换一次？", relevant: "云舟科技员工手册.md", type: "歧义通用词" },
  { q: "密码有什么要求？", relevant: "云舟科技员工手册.md", type: "歧义通用词" },
  { q: "出差住宿标准是多少？", relevant: "云舟科技员工手册.md", type: "歧义通用词" },
  { q: "出差餐补每天多少？", relevant: "云舟科技员工手册.md", type: "歧义通用词" },
  { q: "新员工入职培训多久？", relevant: "云舟科技员工手册.md", type: "歧义通用词" },
  { q: "绩效考核多久一次？", relevant: "云舟科技员工手册.md", type: "歧义通用词" },
  { q: "加班怎么补偿？", relevant: "云舟科技员工手册.md", type: "歧义通用词" },
  { q: "设备用满几年可以更换？", relevant: "云舟科技员工手册.md", type: "通用词" },
  { q: "ThinkPad T16 由哪个部门发放？", relevant: "云舟科技员工手册.md", type: "专有名词" },
  { q: "MacBook Air M4 需要签署什么协议？", relevant: "云舟科技员工手册.md", type: "专有名词" },
  // ===== 星河网络考勤管理制度（7 条）=====
  { q: "请假需要提前几个工作日？", relevant: "星河网络考勤管理制度.md", type: "歧义通用词" },
  { q: "年假转正后可以享受吗？", relevant: "星河网络考勤管理制度.md", type: "歧义通用词" },
  { q: "加班费是怎么计算的？", relevant: "星河网络考勤管理制度.md", type: "歧义通用词" },
  { q: "单笔报销超过 3000 元怎么办？", relevant: "星河网络考勤管理制度.md", type: "歧义通用词" },
  { q: "远程办公每周最多几天？", relevant: "星河网络考勤管理制度.md", type: "歧义通用词" },
  { q: "迟到会有什么后果？", relevant: "星河网络考勤管理制度.md", type: "通用词" },
  { q: "全薪病假有几天？", relevant: "星河网络考勤管理制度.md", type: "通用词" },
  // ===== 蓝海传媒人事制度（5 条）=====
  { q: "蓝海传媒的年假怎么计算？", relevant: "蓝海传媒人事制度.md", type: "歧义通用词" },
  { q: "蓝海传媒加班有加班费吗？", relevant: "蓝海传媒人事制度.md", type: "歧义通用词" },
  { q: "补卡扣多少钱？", relevant: "蓝海传媒人事制度.md", type: "歧义通用词" },
  { q: "蓝海传媒试用期多长？", relevant: "蓝海传媒人事制度.md", type: "通用词" },
  { q: "竞业限制期限多久？", relevant: "蓝海传媒人事制度.md", type: "通用词" },
  // ===== 向量数据库选型指南（9 条）=====
  { q: "BGE-M3 的向量维度是多少？", relevant: "向量数据库选型指南.md", type: "专有名词" },
  { q: "什么是 Recall@K？", relevant: "向量数据库选型指南.md", type: "专有名词" },
  { q: "RRF 是什么方法？", relevant: "向量数据库选型指南.md", type: "专有名词" },
  { q: "什么是 HNSW 索引？", relevant: "向量数据库选型指南.md", type: "专有名词" },
  { q: "pgvector 适合什么规模的数据？", relevant: "向量数据库选型指南.md", type: "专有名词" },
  { q: "Chroma 适合什么场景？", relevant: "向量数据库选型指南.md", type: "专有名词" },
  { q: "切换嵌入模型需要注意什么？", relevant: "向量数据库选型指南.md", type: "专有名词" },
  { q: "向量索引需要定期重建吗？", relevant: "向量数据库选型指南.md", type: "专有名词" },
  { q: "Milvus 的缺点是什么？", relevant: "向量数据库选型指南.md", type: "专有名词" },
  // ===== 云舟科技数据安全规范（4 条）=====
  { q: "数据需要多久备份一次？", relevant: "云舟科技数据安全规范.md", type: "歧义通用词" },
  { q: "备份保留多长时间？", relevant: "云舟科技数据安全规范.md", type: "歧义通用词" },
  { q: "恢复时间目标是多少？", relevant: "云舟科技数据安全规范.md", type: "专有名词" },
  { q: "数据分为几个等级？", relevant: "云舟科技数据安全规范.md", type: "通用词" },
  // ===== 员工健身与福利指南（4 条）=====
  { q: "年度体检包含哪些项目？", relevant: "员工健身与福利指南.md", type: "歧义通用词" },
  { q: "健身房开放时间？", relevant: "员工健身与福利指南.md", type: "通用词" },
  { q: "心理咨询每年可以预约几次？", relevant: "员工健身与福利指南.md", type: "通用词" },
  { q: "篮球场怎么预约？", relevant: "员工健身与福利指南.md", type: "通用词" },
  // ===== RAG 系统开发实践（3 条）=====
  { q: "分块大小一般取多少？", relevant: "RAG系统开发实践.md", type: "歧义通用词" },
  { q: "内容哈希有什么用？", relevant: "RAG系统开发实践.md", type: "专有名词" },
  { q: "多轮对话的上下文怎么处理？", relevant: "RAG系统开发实践.md", type: "歧义通用词" },
  // ===== 大模型应用部署指南（3 条）=====
  { q: "SSE 是什么？", relevant: "大模型应用部署指南.md", type: "专有名词" },
  { q: "API Key 应该放在哪里？", relevant: "大模型应用部署指南.md", type: "歧义通用词" },
  { q: "Serverless 有什么限制？", relevant: "大模型应用部署指南.md", type: "专有名词" },
];

// ---------- 评测逻辑 ----------
interface Result {
  query: string;
  type: string;
  relevant: string;
  vectorHit3: boolean;
  hybridHit3: boolean;
  vectorHit5: boolean;
  hybridHit5: boolean;
  vectorTop: string;
  hybridTop: string;
}

/** 结构化类型：只声明脚本用到的 rpc 能力（Supabase 的 rpc 返回 thenable 而非真 Promise） */
type RpcClient = {
  rpc: (
    fn: string,
    args: Record<string, unknown>
  ) => PromiseLike<{ data: unknown; error: { message: string } | null }>;
};

async function search(db: RpcClient, rpc: string, params: Record<string, unknown>, k: number) {
  const { data, error } = await db.rpc(rpc, { ...params, match_count: k });
  if (error) throw new Error(error.message);
  return data as { document_id: string }[];
}

async function main() {
  loadEnv();
  const db = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false },
  });
  const embeddings = new OpenAIEmbeddings({
    model: process.env.EMBEDDING_MODEL!,
    apiKey: process.env.SILICONFLOW_API_KEY!,
    configuration: { baseURL: "https://api.siliconflow.cn/v1" },
    timeout: 60_000,
  });

  // 1. 生成干扰文档（固定种子，可复现），与目标文档一起构成评测语料
  const noiseDir = join(process.cwd(), ".tmp-noise-docs");
  const { execSync } = await import("node:child_process");
  execSync(`pnpm tsx scripts/gen-noise-docs.ts "${noiseDir}"`, { stdio: "inherit" });
  const noiseFiles = readdirSync(noiseDir);

  // 2. 清理旧评测语料（目标文档 + 干扰文档），重新入库
  const corpusFiles = readdirSync(CORPUS_DIR);
  const allFiles = [...corpusFiles, ...noiseFiles];
  for (const f of allFiles) {
    await db.from("documents").delete().eq("filename", f);
  }
  const docIds = new Map<string, string>();
  for (const f of corpusFiles) {
    const buffer = readFileSync(join(CORPUS_DIR, f));
    const r = await ingestDocument(buffer, f);
    if (r.duplicated || !r.documentId) throw new Error(`入库失败: ${f}`);
    docIds.set(f, r.documentId);
    console.log(`已入库目标文档《${f}》（${r.chunkCount} chunks）`);
  }
  let totalChunks = 0;
  for (const f of noiseFiles) {
    const buffer = readFileSync(join(noiseDir, f));
    const r = await ingestDocument(buffer, f);
    if (r.duplicated || !r.documentId) throw new Error(`入库失败: ${f}`);
    totalChunks += r.chunkCount ?? 0;
  }
  console.log(`已入库干扰文档 ${noiseFiles.length} 份（${totalChunks} chunks）`);

  // 2. 逐条评测
  const results: Result[] = [];
  for (const { q, relevant, type } of QUERIES) {
    const vec = await embeddings.embedQuery(q);
    const vectorRes = await search(db, "match_chunks", { query_embedding: JSON.stringify(vec) }, 5);
    const hybridRes = await search(
      db,
      "hybrid_search",
      { query_embedding: JSON.stringify(vec), query_tsquery: buildTsQuery(q) },
      5
    );
    const hit = (res: { document_id: string }[], k: number) =>
      res.slice(0, k).some((c) => docIds.get(relevant) === c.document_id);
    results.push({
      query: q,
      type,
      relevant,
      vectorHit3: hit(vectorRes, 3),
      hybridHit3: hit(hybridRes, 3),
      vectorHit5: hit(vectorRes, 5),
      hybridHit5: hit(hybridRes, 5),
      vectorTop: docIds.get(relevant) === vectorRes[0]?.document_id ? "命中" : "未命中",
      hybridTop: docIds.get(relevant) === hybridRes[0]?.document_id ? "命中" : "未命中",
    });
    console.log(`[${hit(vectorRes, 5) ? "✓" : "✗"}→${hit(hybridRes, 5) ? "✓" : "✗"}] ${q}`);
  }

  // 3. 汇总并写报告
  const sum = (key: keyof Result, type?: string) =>
    results.filter((r) => r[key] === true && (!type || r.type === type)).length;
  const countBy = (type: string) => results.filter((r) => r.type === type).length;
  const n = results.length;
  const types = ["歧义通用词", "通用词", "专有名词"];
  const lines = [
    "# 召回率评测报告（向量 vs BM25+向量混合）",
    "",
    `> 生成时间：${new Date().toISOString()}`,
    "",
    `> **评测规模**：${n} 条 query；语料 ${corpusFiles.length} 份目标文档 + ${noiseFiles.length} 份干扰文档（固定种子生成，可复现）。`,
    "> **规模声明**：本评测为实习项目级别（约 82 chunks）。企业级知识库通常数万 chunks、评测集 200+ 条 query，本报告数据用于对比纯向量与混合检索的**相对提升**，不代表生产效果。",
    "> **标注约定**：query 的正确答案标注为目标文档（多租户知识库中「本公司的规定」），干扰文档中同主题的其他规定视为错误命中。",
    "",
    "## 汇总",
    "",
    "| 指标 | 纯向量 | 混合检索（RRF） | 提升 |",
    "|------|--------|----------------|------|",
    `| Recall@3 | ${sum("vectorHit3")}/${n}（${((sum("vectorHit3") / n) * 100).toFixed(0)}%） | ${sum("hybridHit3")}/${n}（${((sum("hybridHit3") / n) * 100).toFixed(0)}%） | ${sum("hybridHit3") - sum("vectorHit3")} 条 |`,
    `| Recall@5 | ${sum("vectorHit5")}/${n}（${((sum("vectorHit5") / n) * 100).toFixed(0)}%） | ${sum("hybridHit5")}/${n}（${((sum("hybridHit5") / n) * 100).toFixed(0)}%） | ${sum("hybridHit5") - sum("vectorHit5")} 条 |`,
    "",
    "## 分类型 Recall@5",
    "",
    "| 类型 | 条数 | 纯向量 | 混合检索 |",
    "|------|------|--------|----------|",
    ...types.map(
      (t) =>
        `| ${t} | ${countBy(t)} | ${sum("vectorHit5", t)}/${countBy(t)} | ${sum("hybridHit5", t)}/${countBy(t)} |`
    ),
    "",
    "## 逐条明细",
    "",
    "| 类型 | Query | 正确答案 | 向量@3 | 混合@3 | 向量@5 | 混合@5 | 向量Top1 | 混合Top1 |",
    "|------|-------|---------|--------|--------|--------|--------|----------|----------|",
    ...results.map(
      (r) =>
        `| ${r.type} | ${r.query} | ${r.relevant} | ${r.vectorHit3 ? "✓" : "✗"} | ${r.hybridHit3 ? "✓" : "✗"} | ${r.vectorHit5 ? "✓" : "✗"} | ${r.hybridHit5 ? "✓" : "✗"} | ${r.vectorTop} | ${r.hybridTop} |`
    ),
    "",
  ];
  mkdirSync("docs", { recursive: true });
  writeFileSync(join("docs", "eval-results.md"), lines.join("\n"), "utf-8");
  console.log("\n报告已写入 docs/eval-results.md");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
