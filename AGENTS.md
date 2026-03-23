# AGENTS.md

## 1. Purpose

本文件用于约束后续 AI 在本仓库的开发行为，目标是：

- 保证修改可执行、可验证、可回溯。
- 降低上下文切换成本，让 AI 能快速接手。
- 保持代码、文档、运行方式同步。
- 仅维护最终状态，不记录历史变更过程（历史记录由 Git/PR 承载）。

## 2. Project Snapshot

- 项目类型：Supabase Edge Functions（Deno 2.1.x）+ Node 工具链。
- 入口目录：`supabase/functions/*/index.ts`。
- 共享模块：`supabase/functions/_shared/*`。
- 依赖锁定：`supabase/functions/deno.json` 的 `imports` 使用精确版本（exact pin），避免无版本映射。
- 本地启动：
  - `npm install`
  - `npm start`（等价于 `supabase functions serve --env-file ./supabase/.env.local --no-verify-jwt`）
- 主要测试样例：`test.example.http`
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
  - action `prepare_upload` 负责创建 import job / source artifact 并返回 signed upload URL。
  - action `enqueue` 负责将 source artifact 标记为 ready 并触发 `lca_package_enqueue_job`。
- `supabase/functions/tidas_package_jobs`
  - 查询 package job 与关联 artifact。
  - 支持 `GET`/`POST`。
  - 支持 `AuthMethod.JWT` 与 `AuthMethod.USER_API_KEY`。
- `supabase/functions/_shared`
  - 认证、OpenAI、Redis、Supabase client、通用工具。
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
2. 运行最小必要校验（按影响范围）：
   - `deno check` 属于强制步骤：凡涉及 `supabase/functions` 下代码改动（`.ts`/`.js`），必须执行，不可跳过。
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
- 变更“必做流程”或发布流程。

如果改动不涉及以上内容，可不改 `AGENTS.md`，但需要在最终说明中声明“本次无需更新 AGENTS.md”。

## 7. Validation Matrix

- 混合检索相关改动（`flow/process/lifecyclemodel` 或其 shared 依赖）：
  - `deno check` 三个函数至少各跑一次。
  - 用 `test.example.http` 里的对应请求做 smoke test（本地或远程至少一端）。
- OpenAI 共享层改动（`openai_structured.ts` / `openai_chat.ts`）：
  - 至少验证 `responses.create` 可用（`deno eval` 或实际函数调用）。
- LCA 链路改动：
  - 优先用 `scripts/lca_submit_poll_fetch.sh` 验证端到端（本地需 `jq`）。
- TIDAS package import 改动：
  - `npm run lint`
  - `deno check --config supabase/functions/deno.json supabase/functions/import_tidas_package/index.ts`
  - 如果改动触及 `_shared/auth.ts` / `_shared/tidas_package.ts` / `_shared/redis_client.ts`，至少补跑所有直接依赖这些共享模块的 package 相关函数
  - 用 `test.example.http` 中的 `import_tidas_package` / `tidas_package_jobs` 示例至少验证一组本地或远程请求

## 8. Environment & Secrets

- 环境文件：
  - 本地函数运行：`supabase/.env.local`
  - HTTP 调试变量：仓库根目录 `.env`
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
