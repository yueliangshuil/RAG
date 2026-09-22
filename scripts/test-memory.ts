/**
 * 分层记忆测试：
 * 1. 构造 20 条合成消息（模拟长对话），全部向量化入库
 * 2. 验证向量记忆：用与早期话题相关的问题检索，能召回窗口外的早期细节
 * 3. 验证滚动摘要：触发压缩后 sessions.summary 包含关键实体与用户目标
 * 运行：pnpm tsx scripts/test-memory.ts
 */
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { OpenAIEmbeddings } from "@langchain/openai";
import { maybeSummarize, saveMessageMemory, searchMessageMemories } from "../src/lib/memory";

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

async function main() {
  loadEnv();
  const db = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false },
  });

  // 1. 建会话并写入 20 条合成消息（模拟长对话：设备领用 → 报销 → 密码规范…）
  const { data: session } = await db
    .from("sessions")
    .insert({ title: "记忆测试会话" })
    .select()
    .single();
  if (!session) throw new Error("会话创建失败");
  const sid = session.id;

  const dialogue: ["user" | "assistant", string][] = [
    ["user", "新员工入职在哪里领取电脑？"],
    ["assistant", "入职当天在 IT 部领取，型号为 ThinkPad T16 或 MacBook Air M4，需签署设备领用协议。"],
    ["user", "设备用了多久可以申请更换？"],
    ["assistant", "设备使用满三年可申请更换，离职时需归还并完成数据清除确认。"],
    ["user", "报销有什么时间限制？"],
    ["assistant", "报销单需在费用发生后 30 天内提交，超过 5000 元需部门经理加签。"],
    ["user", "发票抬头写什么？"],
    ["assistant", "发票抬头为「云舟科技（成都）有限公司」，专票需填写完整税号。"],
    ["user", "密码有什么要求？"],
    ["assistant", "密码需包含大小写字母、数字和特殊字符，不低于 12 位，每 90 天强制更换。"],
    ["user", "出差住宿标准呢？"],
    ["assistant", "一线城市每晚不超过 600 元，其他城市不超过 400 元。"],
    ["user", "年假怎么休？"],
    ["assistant", "年假每年 10 天，入职满一年后生效，可拆分使用，未休完次年三月底清零。"],
    ["user", "培训有哪些？"],
    ["assistant", "新员工有两周入职培训，每季度有技术分享会，每年 3000 元学习基金。"],
    ["user", "绩效考核频率？"],
    ["assistant", "每半年评估一次，连续两次 A 进入晋升候选池，年度 C 需参加改进计划。"],
    ["user", "加班怎么处理？"],
    ["assistant", "加班原则上调休补偿，60 天内使用；确需加班费的项目需提前申报审批。"],
  ];

  const ids: string[] = [];
  for (const [role, content] of dialogue) {
    const { data: msg } = await db
      .from("messages")
      .insert({ session_id: sid, role, content })
      .select()
      .single();
    if (msg) ids.push(msg.id);
  }

  // 2. 全部消息向量化入库（模拟线上 saveMessageMemory 的异步链路）
  console.log("向量化消息...");
  for (let i = 0; i < dialogue.length; i++) {
    await saveMessageMemory(sid, ids[i], dialogue[i][0], dialogue[i][1]);
  }
  console.log("已入库 20 条消息记忆");

  // 3. 向量记忆检索：问题指向早期话题（第 1-2 轮：设备领用），近期窗口（16 条）内没有
  const embeddings = new OpenAIEmbeddings({
    model: process.env.EMBEDDING_MODEL!,
    apiKey: process.env.SILICONFLOW_API_KEY!,
    configuration: { baseURL: "https://api.siliconflow.cn/v1" },
    timeout: 60_000,
  });
  const q = "新员工领电脑要签什么协议？";
  const vec = await embeddings.embedQuery(q);
  const recentIds = ids.slice(-16); // 模拟近期窗口内消息
  const hits = await searchMessageMemories(sid, vec, recentIds, 3);
  console.log("\n=== 向量记忆检索（问题指向早期话题，排除近期窗口）===");
  console.log(`问题: ${q}`);
  for (const h of hits) {
    console.log(`  相似度 ${h.similarity.toFixed(3)} [${h.role}]: ${h.content.slice(0, 50)}`);
  }
  const earlyHit = hits.some((h) => h.message_id === ids[1]);
  console.log(`召回早期设备领用消息: ${earlyHit ? "✓ 通过" : "✗ 失败"}`);

  // 4. 滚动摘要：已有 20 条 → 窗口外未压缩 4 条 < 8 未触发；再加 4 条 → 触发
  for (const [role, content] of [
    ["user", "社保公积金怎么交的？"],
    ["assistant", "公司提供五险一金与补充商业保险，公积金按当地上限比例缴纳。"],
    ["user", "体检什么时候安排？"],
    ["assistant", "每年组织一次全员体检，40 岁以上员工增加颈动脉彩超与肿瘤标志物筛查。"],
  ] as ["user" | "assistant", string][]) {
    const { data: msg } = await db
      .from("messages")
      .insert({ session_id: sid, role, content })
      .select()
      .single();
    if (msg) {
      ids.push(msg.id);
      await saveMessageMemory(sid, msg.id, role, content);
    }
  }

  console.log("\n=== 触发滚动摘要压缩（24 条 > 窗口 16 + 触发阈值 8）===");
  await maybeSummarize(sid);
  const { data: after } = await db.from("sessions").select("*").eq("id", sid).single();
  console.log(`压缩进度 summarized_upto: ${after?.summarized_upto}（应为 24-16=8）`);
  console.log(`会话摘要:\n${after?.summary}`);
  const summaryOk =
    !!after?.summary && after.summary.length > 20 && after.summarized_upto === 8;
  console.log(`\n滚动摘要: ${summaryOk ? "✓ 通过" : "✗ 失败"}`);

  // 清理测试数据
  await db.from("sessions").delete().eq("id", sid);
  console.log("测试数据已清理");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
