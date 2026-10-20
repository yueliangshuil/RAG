/** 服务端环境变量读取与校验，缺失时抛出带指引的错误 */
export function getEnv(key: string): string {
  const value = process.env[key];
  if (!value || value.trim() === "") {
    throw new Error(`缺少环境变量 ${key}，请在 .env.local 中配置（参考 .env.example）`);
  }
  return value.trim();
}

export function getTopK(): number {
  const raw = process.env.TOP_K;
  const n = raw ? Number.parseInt(raw, 10) : 5;
  return Number.isNaN(n) ? 5 : n;
}

/**
 * 流式演示延迟（毫秒）：每个 chunk 之间的停顿，仅用于演示/排障
 * 断点续流（刷新续收、宽限期取消）需要生成过程持续足够长时间才能肉眼验证，
 * 默认 0 不延迟；演示时设为 150-300。
 */
export function getStreamDelayMs(): number {
  const raw = process.env.DEMO_STREAM_DELAY_MS;
  const n = raw ? Number(raw) : 0;
  return Number.isFinite(n) && n > 0 ? n : 0;
}
