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

## 2026-09-22 · 上传/问答接口全线挂起排障（僵尸开发服务器）

### 12. 症状：所有 POST 挂起、GET 正常，curl 上传超时

- **现象**：POST /api/documents（multipart）与 POST /api/sessions/[id]/chat（JSON）全部挂起 60-180s 无响应；GET 一切正常；服务器日志中**没有**这些请求的记录。
- **误判排除过程**（重要方法论）：
  1. 以为 SiliconFlow 网络问题 → 直连测试 200/1.9s，密钥有效；
  2. 以为 LangChain 嵌入层问题 → 独立 Node 脚本跑 embedDocuments 210ms 成功（1024 维正确）；
  3. 以为 formData 解析问题 → 连"无 body 的 POST"也挂，且基线 POST /api/sessions 也挂。
- **根因**：后台启动 dev server 时用了 `pnpm dev | head -20`。当 .env.local 被修改触发 **env reload（内部重启）** 时，重启打印的日志超过 head 缓冲 → head 退出关闭管道 → pnpm 外壳被杀，但 **node 服务器进程成为孤儿僵尸**：端口 3000 仍在 LISTEN，内部运行时已损坏，所有新连接被接受后永不响应。后续 `pnpm dev` 因端口占用拒绝启动，报 "You can access the existing server... run taskkill /PID 65264 /F"。
- **解法**：`taskkill //PID 65264 //F` 杀掉僵尸进程 → 重启 dev server（**不带 head 管道**，让输出自然写入任务文件）→ 全链路恢复。
- **教训**：
  1. 长驻进程（dev server）后台运行时**不要管道接 head/tail**，管道上游缓冲满会误杀服务；
  2. Next.js 修改 .env.local 会触发内部重启，若服务被"半杀"，表现为端口占用 + 请求挂起 + 日志无记录，先 `netstat -an | grep :3000` 查僵尸监听再 `taskkill`；
  3. LLM/Embedding 客户端必须显式配置 `timeout`（已加 60s），避免 API 无响应时请求永久挂死。

## 2026-09-22 · Phase 2：混合检索与分层记忆（含召回率提升全过程）

### 13. 中文 bigram 分词的 unigram 噪声教训（单测抓出）

- 初版分词器在汉字串开头会额外生成单字 unigram（"请假" → `请 | 请假`），单测 `tokenizer.test.ts` 立即暴露。
- 单字 token 是噪声：一个 500 字分块会产生大量单字，稀释 BM25 得分、膨胀 tsvector。
- 决策：只保留 bigram；孤立单字的查询场景（如"年"）由向量检索语义兜底。单元测试 7 条全绿后进入评测。

### 14. 混合检索选型：RRF 而非加权求和

- 向量相似度（0-1 余弦）与 BM25 的 ts_rank 分数量纲完全不同，直接加权求和需要归一化，脆弱。
- 选用 RRF（Reciprocal Rank Fusion）：各自排名取 `1/(k+rank)` 融合，天然规避量纲问题，SQL 实现一个 CTE 完成。

### 15. 召回率评测方法论迭代（三轮迭代，记录完整过程）

**第一轮失败**：语料 8 份文档每份仅 1-2 chunks（总量 ~15），Top5 覆盖三分之一语料，两种方法全命中 100%——无区分度，评测无效。教训：**语料竞争强度决定评测有效性**。

**第二轮失败**：扩写文档至 2 chunks/份（~30 chunks），仍然全命中。教训：目标文档太少、无相似干扰文档时，检索没有歧义可言。

**第三轮有效**（最终方案）：
- 8 份手写目标文档（三家公司制度共享"请假/年假/报销/密码"主题词制造歧义）+ **32 份固定种子生成的干扰文档**（12 制度 + 12 技术 + 8 杂项，mulberry32 PRNG，可复现）；
- 51 条 query，分三类：歧义通用词 27 / 通用词 9 / 专有名词 15；
- 标注约定：正确答案=目标文档（多租户知识库"本公司的规定"），干扰文档同主题规定视为错误命中；
- 语料总量 ~82 chunks（26 目标 + 56 干扰）。
- **等权 RRF 结果**：Recall@5 71%→75%（+2 条），但有 1 条回归（"新员工入职培训多久"被干扰文档培训章节的 BM25 排名顶掉）——等权让 BM25 噪声过强。
- **权重调优 1.0/0.5**（向量为主信号，BM25 作增强与兜底，迁移 003）：Recall@5 **71%→78%（+4 条，0 回归）**；Recall@3 69%→71%；最难类目歧义通用词 14/27→17/27。
- **规模声明**（用户强调的诚实性原则）：报告明示实习项目级别（~82 chunks / 51 query），企业级通常数万 chunks、200+ query，本数据仅用于对比相对提升。评测报告自动化输出到 `docs/eval-results.md`。

### 16. Postgres 函数重载歧义（迁移 004）

- `create or replace function` 只在签名一致时替换；003 给 hybrid_search 新增权重参数后，新旧两个签名并存，调用 4 参时报 `Could not choose the best candidate function`。
- 解决：迁移 004 显式 `drop function if exists hybrid_search(vector, tsquery, integer, integer)`，只保留带权重版本。
- 教训：改函数签名时必须先 drop 旧签名，create or replace 不覆盖不同签名。

### 17. 分层记忆验证（scripts/test-memory.ts）

- 构造 20 条合成长对话全部向量化入库；用指向早期话题（设备领用，已在 16 条近期窗口之外）的问题检索：**精确召回早期消息（相似度 0.811）**，证明"窗口外的细节不丢"。
- 24 条消息触发滚动摘要：summarized_upto 进度正确（8），摘要结构化输出用户目标与关键实体（ThinkPad T16、5000 元、税号等）。
- 设计要点：消息完整保留在 messages 表，摘要只影响注入上下文的内容；压缩失败不阻塞主流程（try/catch + 日志）。

## 2026-09-22 · Phase 3+4：SSE 断点续流与会话恢复、前端流式渲染优化

### 18. 断点续流架构（企业级模式）

- **核心解耦**：POST /chat 只落库消息并立即返回 messageId，生成任务在后台运行（不 await）；客户端连接 `/api/messages/[id]/stream` 订阅流。刷新页面 ≠ 中断生成——任务继续跑，客户端按消息 ID 重新挂接。
- **断点协议**：`from` 字符偏移（Last-Event-ID 语义）+ delta 事件 id 携带累计字符长度，天然去重、不依赖 chunk 序号。**用字符偏移而非 chunk 序号**：防抖落库后缓冲区可被回收，done 后仍可从 DB 完整文本按偏移切片补发。
- **状态机**：messages.status = generating / done / interrupted（迁移 005），interrupted 保留已生成部分，/continue 从断点续生成（prefill 已生成内容 + 续写指令）。
- **竞态防护**：订阅完成前任务已结束则主动补发终态事件；缓冲丢失且状态 generating → 判定任务丢失（服务重启），置 interrupted 引导续生成。
- **已知限制**：内存缓冲仅适用于单实例（本地 dev）；Vercel serverless 无共享内存与后台任务，部署阶段需引入队列/持久化缓冲，当前实现已保证 serverless 下优雅降级。

### 19. SSE 编码两个内容丢失 bug（E2E 抓出，回归测试覆盖）

1. **data 内换行丢失**：初版 encodeSSE 把含 `\n` 的内容原样放入 data 字段，解析器只认 `data:` 前缀的行，分片内换行后的内容全部丢弃（E2E 发现 DB 521 字符客户端只收到 437）。修复：按行拆分、逐行加 `data:` 前缀。
2. **trimStart 吞掉内容前导空格**：SSE 规范中 `data:` 后只有一个分隔空格，初版用 `trimStart()` 把内容本身的前导空格（Markdown 列表缩进）一并删除（339 个分片累计丢 46 字符）。修复：只去掉一个分隔空格。
- 教训：流式协议 bug 单测测不出（单测只覆盖了无换行/无空格 case），必须靠 E2E 对比「客户端拼接长度 vs DB 最终内容长度」逐字符定位分歧点。

### 20. 优雅取消（AbortController 统一中断机制）

- 客户端断开（AbortController）→ 无订阅者时 **5s 宽限期**后取消后台生成任务；宽限期内新订阅者接入（刷新重连）则撤销取消。同时满足「切换问题=主动取消」「刷新续聊=后台继续跑」。
- **时序 bug**：scheduleCancel 原判定 `!closed`，但 cleanup() 先置 closed=true 再调度 → 取消永不触发。修复：abort 回调中先捕获 naturalEnd 再 cleanup。
- 模型层双保险：stream 传 signal + 每 chunk 检查 aborted。

### 21. 取消链路测试的时序陷阱

- 第一版测试用 DB 手术模拟 interrupted，被指出与真实机制不符；改为 **AbortController 真实断开链路**。
- 短回答在 5s 宽限期内完成 → 生成任务的 finally 清掉定时器 → 取消不触发。这不是 bug 而是设计正确行为（任务已完成无需取消），但测试必须用**长文提问**（30s+ 生成时长）保证取消窗口必然落在生成过程中。
- 教训：异步机制的测试要控制任务时长与窗口的相对关系。

### 22. 流式体验设计（用户强调的体验保障）

- **阶段反馈**：连接后默认显示「正在检索知识库…」，检索完成发 `stage: thinking` 事件切换「正在思考…」，首个 delta 进入流式渲染。
- **模型卡顿**：服务端 15s 心跳 ping（防代理误断 + 客户端感知连接存活）；客户端 20s 无事件提示「模型响应较慢」（不中断连接）。
- **知识库故障三级降级**：混合检索失败 → 纯向量 → 无检索降级回答（系统提示注明检索不可用，模型向用户说明并基于历史尽力回答）；Embedding API 失败同样降级。
- **空知识库引导**：文档数为 0 时不调模型，直接返回引导消息。
- **渲染优化**：代码块围栏缓冲（未闭合 ``` 之后不渲染，闭合追齐）+ 80ms 节流渲染 + 自动滚动（用户上翻时暂停跟随）+ DOMPurify XSS 清洗；服务端 500ms 防抖落库。
