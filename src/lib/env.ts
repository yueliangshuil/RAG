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
