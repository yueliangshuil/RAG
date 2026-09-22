import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { getEnv } from "./env";

/**
 * 服务端 Supabase 客户端（service_role key，绕过 RLS）。
 * 仅允许在服务端代码（API Route / Server Component）中使用，
 * 浏览器端一律走 API Route，不直接访问数据库。
 */
let client: SupabaseClient | null = null;

export function getSupabaseAdmin(): SupabaseClient {
  if (!client) {
    client = createClient(getEnv("SUPABASE_URL"), getEnv("SUPABASE_SERVICE_ROLE_KEY"), {
      auth: { persistSession: false },
    });
  }
  return client;
}
