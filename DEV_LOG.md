# 开发记录（难点与决策）

> 按时间记录开发过程中遇到的难点、关键决策与解决方案。

## 2026-09-22 · 项目初始化

1. **项目名大写被 npm 拒绝**：`create-next-app` 以目录名 `RAG` 作为包名，npm 命名规则不允许大写字母。解决：在临时目录以 `rag-app` 名脚手架生成，用 tar 排除 node_modules 迁移到仓库根目录，package.json 的 name 改为 `rag`。

2. **Chroma 无法托管 Vercel 免费层**（架构决策）：Chroma 需要常驻磁盘和服务进程，Vercel serverless 免费层无法承载。决策：改用 **Supabase pgvector**（Postgres 向量扩展），与 Vercel + Supabase 部署无缝集成；简历中 Chroma 表述后续同步改为 pgvector。

3. **API 供应商选型**（架构决策）：对话用 **DeepSeek**（OpenAI 兼容 API，便宜稳定）；Embedding 用 **SiliconFlow 的 BGE-M3**（有免费额度，与简历 BGE 表述一致）。

4. **git 认证问题**：未配置凭据时 `git ls-remote` 会挂起等待交互输入。解决：检测用 `GIT_TERMINAL_PROMPT=0` 非交互模式；推送依赖 Windows Git Credential Manager。

5. **GitHub 直连被重置，推送需走 Clash 代理**：国内直连 github.com 超时/重置（curl 直连超时，push 报 Recv failure），本机 Clash 监听 127.0.0.1:7890。解决：仓库级配置 `git config http.proxy http://127.0.0.1:7890`，先用 `curl -x` 验证代理返回 200，再推送成功。

6. **BM25 中文分词难点**（设计决策，Phase 2 落地）：Postgres FTS 不支持中文分词，Supabase 无法安装 zhparser 扩展。方案：应用层用 bigram（二元组）对中文分块做 n-gram 分词，生成 tsvector 存入 Supabase 与向量检索混合打分；英文按空格分词。Phase 1 先实现向量检索，混合检索在 Phase 2 完成。

## 2026-09-22 · Docker 与 Supabase 本地环境配置全过程

> 目的：不用注册任何账号，本地自动拉起 Supabase（Postgres + pgvector），CLI 自动生成 API Key。

### 7. Docker Desktop 安装（winget）

- 包 ID 不是 `Docker.sbx`，正确 ID 是 **`Docker.DockerDesktop`**（用 `winget search --id Docker.DockerDesktop -e` 确认，当前版本 4.91.0）。
- winget 首次运行会弹「msstore 源协议」交互提示，非交互 shell 下报 `0x8a150042` 错误。解决：加 `--accept-source-agreements --disable-interactivity`。
- 安装命令：
  `winget install --id Docker.DockerDesktop -e --accept-source-agreements --accept-package-agreements --silent --disable-interactivity`
- 安装器要求管理员权限（UAC），需要用户在屏幕上点「是」；静默安装成功。
- 装完后**当前 shell 找不到 docker 命令**：安装器修改的是注册表 PATH，已启动的进程树（VSCode/终端）继承的是旧环境变量。解决：用完整路径 `/c/Program Files/Docker/Docker/resources/bin/docker.exe` 调用，或重启终端。

### 8. Docker Desktop 启动与守护进程检测

- 启动：`cmd //c start "" "C:\Program Files\Docker\Docker\Docker Desktop.exe"`（后台分离启动，避免 shell 阻塞）。
- 首次启动有许可协议弹窗，用户点击接受；WSL2 后端自动初始化，无需手工操作。
- 检测守护进程就绪：`docker info --format '{{.ServerVersion}}'`，返回版本号（29.8.0）即就绪。

### 9. Supabase CLI 安装（依赖 Docker，零账号）

- CLI 的 npm 包安装时会从 **GitHub Releases 下载二进制**，国内网络必须走代理：
  `HTTP_PROXY=http://127.0.0.1:7890 HTTPS_PROXY=http://127.0.0.1:7890 pnpm add -D supabase`
- 后续步骤：`supabase init` → `supabase start`（自动拉镜像、启动本地栈、自动生成 ANON_KEY 与 SERVICE_ROLE_KEY）→ `supabase status` 读取本地 API 地址与密钥，填入 .env.local。
- 与云端的区别：本地栈不需要账号、密钥自动生成；部署阶段再切换到云端 Supabase 项目（届时只需改 .env.local 两个值）。

### 10. supabase start 报错：docker: command not found（PATH 传递问题）

- **报错信息**：`LegacyDockerLifecycleInspectError: failed to inspect container health: docker: command not found (podman also not found)`。Docker 守护进程明明在运行，但 CLI 的子进程找不到 docker 可执行文件。
- **根因**：Docker 安装器只更新了注册表 PATH，当前进程树（VSCode → Claude → Git Bash → pnpm → supabase CLI）继承的是启动时的旧环境变量，新进程虽然能读到新 PATH，但本次会话的所有子进程都拿不到。
- **解决**：把 docker.exe 软链到 Git Bash 恒定的 PATH 目录 `/usr/local/bin`（该目录在 Git Bash 的 PATH 中），对所有新旧 shell 一劳永逸：
  `ln -sf "/c/Program Files/Docker/Docker/resources/bin/docker.exe" /usr/local/bin/docker`
- **教训**：Windows 下安装任何 CLI 工具后，当前会话需要软链/全路径调用，重启终端（或重启 VSCode）才会刷新 PATH。

### 11. 本地 Supabase 栈启动成功（零账号方案验证）

- 软链 docker 后前台可用、**后台任务 shell 仍找不到 docker**（后台 shell 用的是会话启动时的环境快照）。最终解法：命令内显式 `export PATH="/c/Program Files/Docker/Docker/resources/bin:$PATH"` 再执行 supabase 命令，与 shell 环境无关，最稳。
- 镜像源为 `public.ecr.aws`（AWS ECR），国内无需代理可达；首次启动拉取约 12 个镜像（edge-runtime 1.12GB、storage-api 1.38GB、postgres 等），全程约 10 分钟。
- `supabase start` 成功后输出完整密钥：API_URL=`http://127.0.0.1:54321`，SERVICE_ROLE_KEY / ANON_KEY 自动生成，填入 .env.local 即可。
- 验证迁移：`docker exec supabase_db_RAG psql -U postgres -c "select extname from pg_extension;"` 确认 `vector` 扩展与 4 张表（sessions/messages/documents/chunks）均已创建。
- **遗留问题**：`supabase_vector_RAG`（Logflare 日志服务容器）处于 Restarting 状态——它是可选的日志分析组件，与 pgvector 无关（pgvector 在 postgres 镜像内置），不影响应用；若持续重启可忽略或后续排查内存限制。
