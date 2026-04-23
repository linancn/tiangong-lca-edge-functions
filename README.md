---
title: TianGong LCA Edge Functions Landing
docType: overview
scope: repo
status: active
authoritative: false
owner: edge-functions
language: en
whenToUse:
  - when you need the shortest high-level description of what this repo owns
  - when landing in the repo without needing the full AI contract surface yet
whenToUpdate:
  - when repo purpose, setup, or branch/deploy summary changes
  - when the AI entry surface listed here changes
checkPaths:
  - README.md
  - AGENTS.md
  - .docpact/config.yaml
  - docs/agents/**
lastReviewedAt: 2026-04-23
lastReviewedCommit: 63e23a8cb916cb49521cbbe869b38d637040a8b5
related:
  - AGENTS.md
  - .docpact/config.yaml
  - docs/agents/repo-validation.md
  - docs/agents/repo-architecture.md
---

# TianGong-LCA-Edge-Functions

## Overview

Supabase Edge Functions for LCA search, embedding, TIDAS package orchestration, and solving workflows.

- Runtime: Supabase Edge Runtime (Deno 2.1.x)
- Functions root: `supabase/functions`
- Local serve command: `npm start`

## AI Docs Entry

For the AI-facing checked-in contract layer, start with:

1. `AGENTS.md`
2. `.docpact/config.yaml`
3. `docs/agents/repo-validation.md`
4. `docs/agents/repo-architecture.md`
5. `.github/PULL_REQUEST_TEMPLATE/*.md` only when you need PR handoff details

These files are the low-token entry path for repo ownership, branch and deploy rules, validation, and cross-repo boundaries. `README.md` remains the human-oriented setup and operations guide. `test.example.http` is a supporting request collection for concrete payloads, not part of the governed AI contract surface.

## Branch & Deployment Contract

- 本仓库采用以下分支规则：Git `dev` 是日常 trunk，routine PR 默认回 `dev`，`dev -> main` 是 promote 路径，hotfix 从 `main` 起并在合并后回合并到 `dev`。
- GitHub default branch 继续保持 `main`，这是平台层例外，不代表日常 trunk 改回 `main`。
- 远端环境映射：
  - `main` project ref：`qgzvkongdjqiiamzbbts`
  - `dev` project ref：`fotofiyqnuyvgtotswie`
- 远端 `main` 与 `dev` 的函数部署都统一使用 `--no-verify-jwt`。这是正式仓库规则，不是临时口头 workaround。
- 安全边界在函数运行时：gateway 不做 JWT 校验，不等于函数可以匿名执行。新函数不得假设 gateway `verify_jwt=true` 已经帮你兜底，必须继续显式做认证与授权。

## Prerequisites

- Node.js 22
- Docker Engine (required if you run local Supabase stack)

Initialize/refresh Node dependencies:

```bash
npm update && npm ci
```

## Environment Setup

### 1. Function runtime env (`supabase/.env.local`)

Use the template under `supabase`:

```bash
cp supabase/.env.example supabase/.env.local
```

Required keys are managed in this file, for example:

- `OPENAI_API_KEY`
- `OPENAI_CHAT_MODEL`
- `REMOTE_SUPABASE_URL`
- `REMOTE_SUPABASE_SERVICE_ROLE_KEY` (or `REMOTE_SUPABASE_SECRET_KEY`) for privileged RPC / database execution
- `REMOTE_SUPABASE_PUBLISHABLE_KEY` (or `REMOTE_SUPABASE_ANON_KEY`) for JWT validation and request-scoped user clients
- `REMOTE_SERVICE_API_KEY` only for `AuthMethod.SERVICE_API_KEY` request authentication
- `UPSTASH_REDIS_URL`
- `UPSTASH_REDIS_TOKEN`

Credential contract:

- `REMOTE_SERVICE_API_KEY` / `SERVICE_API_KEY` are custom function-level shared secrets. They are not Supabase client credentials.
- JWT validation and user-api-key sign-in flows must use publishable / anon keys.
- Service-role or secret keys are reserved for privileged Supabase execution paths.

### 2. HTTP test env (repo root `.env`)

`test.example.http` reads variables from repository root `.env`:

- `LOCAL_ENDPOINT` (for local function URL)
- `REMOTE_ENDPOINT` (for remote function URL)
- `USER_API_KEY`
- `X_REGION`
- and other request-only values like `X_KEY`, `SECRET_VALUE`

## Local Development

### Serve Edge Functions

```bash
npm start
```

`npm start` is equivalent to:

```bash
./node_modules/.bin/supabase functions serve --env-file ./supabase/.env.local --no-verify-jwt
```

### Optional: Start full local Supabase stack

```bash
npx supabase start
```

Typical endpoints:

- API URL: `http://127.0.0.1:54321`
- Studio URL: `http://127.0.0.1:54323`
- DB URL: `postgresql://postgres:postgres@127.0.0.1:54322/postgres`

## Local Test

### Quick smoke test

```bash
curl -i --location --request POST 'http://127.0.0.1:54321/functions/v1/embedding' \
  --header 'Content-Type: application/json' \
  --data '{"query":["Hello", "World"]}'
```

### Request collection

See `test.example.http` for local and remote examples. Treat it as a supporting artifact for concrete payloads rather than a canonical AI contract doc. It currently includes:

- `flow_hybrid_search`
- `process_hybrid_search`
- `lifecyclemodel_hybrid_search`
- `ai_suggest`
- `lca_solve` / `lca_jobs` / `lca_results`
- `lca_query_results`
- `lca_contribution_path` / `lca_contribution_path_result`
- `import_tidas_package` / `tidas_package_jobs`

### Auth / connectivity probe

当你怀疑远端出现“函数通了，但 auth 行为漂移”这类问题时，优先跑仓库内的统一探测脚本：

```bash
npm run probe:auth -- --remote
```

脚本会自动读取：

- 根目录 `.env` 中的 `REMOTE_ENDPOINT` / `LOCAL_ENDPOINT`
- `USER_JWT`
- `USER_API_KEY`
- `supabase/.env.local` 或 shell env 里的 `REMOTE_SERVICE_API_KEY` / `SERVICE_API_KEY`

也可以显式覆盖：

```bash
EDGE_BASE_URL="https://<project-ref>.supabase.co/functions/v1" \
USER_JWT="<your-user-jwt>" \
npm run probe:auth -- --base-url "$EDGE_BASE_URL"
```

默认行为：

- 默认跳过仓库中标记为 disabled 的 `antchain_*` 和 legacy 非 `*_ft` embedding / webhook 入口
- 默认跳过仅供本地辅助使用的 `embedding_ft_local`
- 对其余函数至少发一轮无鉴权最小请求，并在有对应凭据时继续发 JWT / user API key / service API key 探测
- 结果会区分：
  - `gateway_invalid_jwt`：大概率是请求在进入函数前就被平台层拦住
  - `function_auth_failed`：请求已进入函数，但函数内鉴权拒绝了该凭据
  - `reachable_but_payload_invalid`：连通性和鉴权大概率没问题，只是最小 probe body 不满足业务校验

常用参数：

```bash
# 只看 lca_* 这组
npm run probe:auth -- --remote --only lca_

# 把默认跳过的 disabled / local-only 入口也带上
npm run probe:auth -- --remote --include-disabled --include-local-only

# 输出 JSON 报告，方便留存对比
npm run probe:auth -- --remote --json-out ./tmp/edge-probe-report.json

# 不发请求，只看当前脚本会如何分类和选择鉴权方式
npm run probe:auth -- --dry-run
```

## OpenAI Integration Baseline

- No LangChain dependency in active path.
- OpenAI SDK mapping is in `supabase/functions/deno.json`:
  - `@openai/openai -> npm:openai@6.27.0`
- Shared wrappers:
  - `supabase/functions/_shared/openai_structured.ts`
  - `supabase/functions/_shared/openai_chat.ts`
- Default model fallback in code is `gpt-4.1-mini` when env/model option is not provided.

## Required Development Workflow

After any code or document update:

1. Run lint/format:

```bash
npm run lint
```

2. Run the repo baseline Deno checks:

```bash
npm run check
```

This baseline intentionally skips the currently disabled `antchain_*` functions and the legacy non-`*_ft` embedding/webhook entrypoints (`embedding`, `webhook_flow_embedding`, `webhook_process_embedding`, `webhook_model_embedding`). If you reactivate any of them, bring them back into the baseline and fix their type-check state in the same change.

3. Run minimal checks for affected files when you need scoped verification during iteration:

```bash
deno check --config supabase/functions/deno.json <changed-file>
```

4. Keep docs synced:

- Update `README.md` for human-facing workflow changes.
- Update `AGENTS.md` for repo contract, boundaries, or minimal execution-fact changes.
- Update `.docpact/config.yaml` when routing, ownership, governed-doc rules, or freshness coverage changes.

## LCA Queue RPC Prerequisite

`lca_solve` does not use direct `postgres` connections. It enqueues jobs via Supabase RPC:

- `public.lca_enqueue_job(p_queue_name text, p_message jsonb)`

Ensure this function exists in your database:

```sql
create or replace function public.lca_enqueue_job(p_queue_name text, p_message jsonb)
returns bigint
language plpgsql
security definer
set search_path = public, pgmq
as $$
declare
  v_msg_id bigint;
begin
  select pgmq.send(p_queue_name, p_message) into v_msg_id;
  return v_msg_id;
end;
$$;

revoke all on function public.lca_enqueue_job(text, jsonb) from public;
revoke execute on function public.lca_enqueue_job(text, jsonb) from anon, authenticated;
grant execute on function public.lca_enqueue_job(text, jsonb) to service_role;
```

## LCA Function Call Patterns

- `lca_solve`: `POST` only.
  - optional `data_scope`: `"current_user"` (default), `"open_data"`, `"all_data"`
  - body can combine `data_scope` with normal solve payload, for example `{ "data_scope": "current_user", "demand": { "process_index": 0, "amount": 1.0 } }`
  - snapshot family semantics: all three scopes reuse the same user-enhanced snapshot family, i.e. published data plus the current user's private data
  - root-process semantics stay distinct: `current_user` only accepts current-user processes, `open_data` only accepts published processes, `all_data` accepts published plus current-user processes
  - missing snapshot auto-build is attempted for every `data_scope`
- `lca_jobs`: supports `GET` and `POST`.
  - `GET`: `/functions/v1/lca_jobs/{jobId}` or `?job_id=...`
  - `POST`: body `{ "job_id": "<uuid>" }`
- `lca_results`: supports `GET` and `POST`.
  - `GET`: `/functions/v1/lca_results/{resultId}` or `?result_id=...`
  - `POST`: body `{ "result_id": "<uuid>" }`
- `lca_query_results`: `POST` only.
