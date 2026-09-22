/**
 * 回填脚本：为迁移前已入库的 chunks 计算 bigrams
 * 运行：pnpm tsx scripts/backfill-bigrams.ts
 */
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { bigramTokenize } from "../src/lib/tokenizer";

function loadEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of readFileSync(".env.local", "utf-8").split("\n")) {
    const idx = line.indexOf("=");
    if (idx > 0 && !line.trim().startsWith("#")) {
      env[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    }
  }
  return env;
}

async function main() {
  const env = loadEnv();
  const db = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  const { data: chunks, error } = await db
    .from("chunks")
    .select("id, content")
    .is("bigrams", null);
  if (error) throw new Error(error.message);

  console.log(`待回填 chunks: ${chunks.length}`);
  let done = 0;
  for (const c of chunks) {
    const { error: uerr } = await db
      .from("chunks")
      .update({ bigrams: bigramTokenize(c.content).join(" ") })
      .eq("id", c.id);
    if (uerr) console.error(`回填失败 ${c.id}: ${uerr.message}`);
    else done++;
  }
  console.log(`回填完成: ${done}/${chunks.length}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
