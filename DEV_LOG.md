# 开发记录（难点与决策）

> 按时间记录开发过程中遇到的难点、关键决策与解决方案。

## 2026-09-22 · 项目初始化

1. **项目名大写被 npm 拒绝**：`create-next-app` 以目录名 `RAG` 作为包名，npm 命名规则不允许大写字母。解决：在临时目录以 `rag-app` 名脚手架生成，用 tar 排除 node_modules 迁移到仓库根目录，package.json 的 name 改为 `rag`。

2. **Chroma 无法托管 Vercel 免费层**（架构决策）：Chroma 需要常驻磁盘和服务进程，Vercel serverless 免费层无法承载。决策：改用 **Supabase pgvector**（Postgres 向量扩展），与 Vercel + Supabase 部署无缝集成；简历中 Chroma 表述后续同步改为 pgvector。

3. **API 供应商选型**（架构决策）：对话用 **DeepSeek**（OpenAI 兼容 API，便宜稳定）；Embedding 用 **SiliconFlow 的 BGE-M3**（有免费额度，与简历 BGE 表述一致）。

4. **git 认证问题**：未配置凭据时 `git ls-remote` 会挂起等待交互输入。解决：检测用 `GIT_TERMINAL_PROMPT=0` 非交互模式；推送依赖 Windows Git Credential Manager。
