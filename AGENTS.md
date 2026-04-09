# AGENTS.md

## 1. Purpose

本文件用于约束后续 AI 在本仓库的开发行为，目标是：

- 保证修改可执行、可验证、可回溯。
- 降低上下文切换成本，让 AI 能快速接手。
- 保持代码、文档、运行方式同步。
- 仅维护最终状态，不记录历史变更过程（历史记录由 Git/PR 承载）。

## 2. Project Snapshot

- 项目类型：Supabase Edge Functions（Deno 2.1.x）+ Node 工具链。
- 分支模型：本仓库保持 GitHub default branch 为 `main` 这一平台层例外，但日常 trunk 是 Git `dev`；routine PR 默认回 `dev`，promote 路径是 `dev -> main`，hotfix 从 `main` 起并在合并后 `main -> dev` 回合并。
- 入口目录：`supabase/functions/*/index.ts`。
- 共享模块：`supabase/functions/_shared/*`。
- Deno 测试文件统一放在仓库根目录 `test/*`，不要放在 `supabase/functions/**` 下。
- 依赖锁定：`supabase/functions/deno.json` 的 `imports` 使用精确版本（exact pin），避免无版本映射。
- 远端环境映射：
  - Git `main` / 远端 `main` project ref：`qgzvkongdjqiiamzbbts`
  - Git `dev` / 持久化远端 `dev` branch project ref：`culgbbvzltdodcpykupc`
- 本地启动：
  - `npm install`
  - `npm start`（等价于 `supabase functions serve --env-file ./supabase/.env.local --no-verify-jwt`）
  - `npm run probe:auth -- --remote`（远端 edge functions 连通性 / 鉴权探测；也可用 `--local` 或 `--base-url`）
- 基线校验命令：
  - `npm run lint`
  - `npm run check`（依次对当前启用的 `supabase/functions/*/index.ts` 与 `test/*.ts` 执行 `deno check`；当前默认排除 README 中已标记为 not enabled 的 `antchain_*` 与 legacy 非 `*_ft` embedding/webhook 入口）
- 正式远端部署入口：
  - `npm run deploy:dev -- <function-name> [more-function-names...]`
  - `npm run deploy:main -- <function-name> [more-function-names...]`
  - 两类远端部署都固定追加 `--no-verify-jwt`
- 安全边界：
  - 远端 `main` 与 `dev` gateway 都不负责 JWT 校验
  - 函数运行时必须继续完成认证与授权
  - 新函数不得假设 gateway `verify_jwt=true` 已经帮你兜底
- 主要测试样例：`test.example.http`
- 鉴权排障脚本：`scripts/probe-functions-auth.cjs`
- 主要说明文档：`README.md`

## 3. Directory Guide

- `supabase/functions/flow_hybrid_search`、`process_hybrid_search`、`lifecyclemodel_hybrid_search`
  - 混合检索函数（LLM query rewrite + 向量/全文检索）。
- `supabase/functions/ai_suggest`
  - AI 建议生成函数。
- `supabase/functions/embedding*`、`webhook_*embedding*`
  - 嵌入与 webhook 处理链路。
- `supabase/functions/lca_*`
  - LCA 求解、任务查询、结果查询。
  - `lca_solve`
    - `data_scope` 可选 `current_user` / `open_data` / `all_data`
    - 三个 scope 都复用同一类用户增强 snapshot（公开数据 + 当前用户数据）
    - 请求时仍按根过程语义区分：`current_user = 当前用户过程`，`open_data = 公开过程`，`all_data = 当前用户 + 公开过程`
    - 三个 scope 在缺少 ready snapshot 时都可自动触发构建
  - `lca_query_results` 当前同时支持：
    - `process_all_impacts`
    - `processes_one_impact` 显式 `process_ids` 对比
    - `processes_one_impact` 通过 `top_n/offset/sort_by/sort_direction` 做 snapshot 级热点排名
    - `data_scope` 可选 `current_user` / `open_data` / `all_data`
    - 三个 scope 都复用同一类用户增强 snapshot（公开数据 + 当前用户数据）
    - 请求时仍按过程 scope 过滤：`current_user = 当前用户过程`，`open_data = 公开过程`，`all_data = 当前用户 + 公开过程`
    - 三个 scope 在缺少 ready snapshot 时都可自动触发构建
  - `lca_contribution_path`
    - 提交某个 `process + impact` 的路径分析异步作业
    - 复用 `lca_jobs + lca_result_cache + lca_results`
    - `data_scope` 规则与 `lca_query_results` 一致
  - `lca_contribution_path_result`
    - 读取 `contribution-path:v1` JSON artifact 并返回解析结果
- `supabase/functions/import_tidas_package`
  - TIDAS ZIP 导入入口。
  - `POST` only。
  - 支持 `AuthMethod.JWT` 与 `AuthMethod.USER_API_KEY`。
  - JWT 请求不应依赖 Redis；Redis 仅用于 `USER_API_KEY` 鉴权缓存。
  - action `prepare_upload` 负责创建 import job / source artifact 并返回 signed upload URL。
  - action `enqueue` 负责将 source artifact 标记为 ready 并触发 `lca_package_enqueue_job`。
- `supabase/functions/tidas_package_jobs`
  - 查询 package job 与关联 artifact。
  - 支持 `GET`/`POST`。
  - 支持 `AuthMethod.JWT` 与 `AuthMethod.USER_API_KEY`。
  - 成功响应在保留原始 `diagnostics` 的同时，额外返回 `diagnostics_summary`，用于稳定暴露 `error_code`、`message`、`stage`、`upload_mode`、`artifact_byte_size`、`http_status`、`storage_error_code`、`is_oversize`
  - package export `open_data` scope 现在按 `state_code` `100..199` 识别公开数据，不再把旧的 `99` 视作公开数据
- `supabase/functions/_shared`
  - 认证、OpenAI、Redis、Supabase client、通用工具。
- `supabase/functions/app_dataset_save_draft`、`app_dataset_assign_team`、`app_dataset_publish`、`app_dataset_submit_review`
  - 数据集命令入口。
  - 统一走 command runtime + request-scoped Supabase client，不再让 repository 隐式回退到 service-role client。
- `supabase/functions/_shared/command_runtime`
  - 命令式函数的 HTTP、JSON 解析、actor context、审计 payload、公用 handler 骨架。
- `supabase/functions/_shared/db_rpc`
  - Edge 到数据库 command/query RPC 的薄封装。
- `supabase/functions/_shared/commands/dataset`
  - 数据集命令的类型、校验、policy、repository 和执行器。
- `test/*`
  - 仓库级 Deno 测试文件；共享模块和函数相关测试也放这里，通过相对路径引用 `supabase/functions/**` 代码。
- `scripts/lca_submit_poll_fetch.sh`
  - LCA submit/poll/fetch 联调脚本（依赖 `jq`）。

## 4. OpenAI Integration Baseline

- 当前统一依赖映射在 `supabase/functions/deno.json`：
  - `@openai/openai -> npm:openai@6.27.0`
  - `@supabase/functions-js/edge-runtime.d.ts -> jsr:@supabase/functions-js@2.98.0/edge-runtime.d.ts`
  - `@supabase/supabase-js@2 -> jsr:@supabase/supabase-js@2.98.0`
- 代码中统一使用：
  - `import OpenAI from "@openai/openai";`
- 默认优先 `responses.create`；若需要兼容，允许在共享层做回退逻辑。
- 与同义词相关逻辑统一放在：
  - `supabase/functions/_shared/hybrid_query_utils.ts`

## 5. Non-Negotiable Workflow (MUST)

每次 AI 对代码做任何改动后，必须执行以下步骤：

1. 运行格式与规范脚本：
   - `npm run lint`
2. 运行校验脚本：
   - `npm run check` 是默认基线，提交前 / PR 前应通过。
   - 若涉及 `supabase/functions` 下代码改动（`.ts`/`.js`），`deno check` 属于强制步骤，不可跳过。
   - scoped 迭代时仍按影响范围补跑针对性 `deno check`：
     - 单函数改动：`deno check --config supabase/functions/deno.json <changed-file>`
     - 共享模块改动：至少覆盖所有直接依赖该模块的函数。
3. 同步文档：
   - 若改动影响开发流程、依赖版本、函数行为、验证方式，必须同步更新 `AGENTS.md`（必要时同时更新 `README.md`）。
4. 输出结果时明确：
   - 改了哪些文件
   - 运行了哪些命令
   - 哪些校验通过/未执行及原因

## 6. AGENTS.md Sync Rules (MUST)

出现以下任一情况，必须更新本文件：

- 新增/删除函数目录。
- 变更核心依赖（如 OpenAI SDK、Supabase runtime 相关依赖）。
- 变更统一开发命令、lint/format/test 命令。
- 变更共享模块职责边界（`_shared` 下）。
- 变更“必做流程”、分支模型或发布/部署流程。

如果改动不涉及以上内容，可不改 `AGENTS.md`，但需要在最终说明中声明“本次无需更新 AGENTS.md”。

## 7. Validation Matrix

- 混合检索相关改动（`flow/process/lifecyclemodel` 或其 shared 依赖）：
  - `npm run check`
  - `deno check` 三个函数至少各跑一次。
  - 用 `test.example.http` 里的对应请求做 smoke test（本地或远程至少一端）。
- OpenAI 共享层改动（`openai_structured.ts` / `openai_chat.ts`）：
  - `npm run check`
  - 至少验证 `responses.create` 可用（`deno eval` 或实际函数调用）。
- LCA 链路改动：
  - `npm run check`
  - 优先用 `scripts/lca_submit_poll_fetch.sh` 验证端到端（本地需 `jq`）。
- TIDAS package import 改动：
  - `npm run lint`
  - `npm run check`
  - `deno check --config supabase/functions/deno.json supabase/functions/import_tidas_package/index.ts`
  - 如果改动触及 `_shared/auth.ts` / `_shared/tidas_package.ts` / `_shared/redis_client.ts`，至少补跑所有直接依赖这些共享模块的 package 相关函数
  - 用 `test.example.http` 中的 `import_tidas_package` / `tidas_package_jobs` 示例至少验证一组本地或远程请求

## 8. Environment & Secrets

- 环境文件：
  - 本地函数运行：`supabase/.env.local`
  - HTTP 调试变量：仓库根目录 `.env`
- 如果本地 serve 需要把 `app_dataset_*` 请求转发到远端 Supabase 项目并保留用户 JWT 语义，补充 `REMOTE_SUPABASE_PUBLISHABLE_KEY`（或 `REMOTE_SUPABASE_ANON_KEY`）供 request-scoped client 使用。
- 严禁在提交、日志、回答中泄露密钥、token、完整连接串。
- 展示命令输出时，默认对敏感字段脱敏。

## 9. Change Strategy for AI

- 优先改共享层，避免在多个函数复制逻辑。
- 优先“小步可验证”，一次只解决一个明确问题。
- 不做与请求无关的大范围重构。
- 不引入新依赖，除非有明确必要并在 `AGENTS.md`/`README.md` 记录原因。

## 10. Suggested Final Response Template

每次完成开发后，建议按以下结构输出：

1. 结果摘要（1-3 句）。
2. 变更文件列表。
3. 执行的验证命令与结果。
4. 风险/后续建议（如有）。
