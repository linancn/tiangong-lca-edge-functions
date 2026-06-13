---
title: TianGong LCA Edge Functions
docType: guide
scope: repo
status: active
authoritative: false
owner: edge-functions
language: en
whenToUse:
  - when setting up or serving edge functions locally
  - when finding human-facing request examples and runtime environment notes
whenToUpdate:
  - when setup, local serve, request examples, or operator-facing runtime guidance changes
checkPaths:
  - .env.example
  - README.md
  - package.json
  - supabase/config.toml
  - supabase/.env.example
  - test.example.http
lastReviewedAt: 2026-06-13
lastReviewedCommit: 48ab390581ed832411f342a9ea8fb7ef31eb94a7
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
- Supabase CLI 2.106.0, installed through this repository's `supabase` dev dependency

Initialize/refresh Node dependencies:

```bash
npm install --package-lock=false
```

## Environment Setup

### 1. Function runtime env (`supabase/.env.local`)

Use the template under `supabase`:

```bash
cp supabase/.env.example supabase/.env.local
```

Required keys are managed in this file. Keep this file local-only; do not copy it to the repository root `.env`.

Core entries:

- `REMOTE_SUPABASE_URL`
- `REMOTE_SUPABASE_PUBLISHABLE_KEY` for JWT validation and request-scoped user clients.
- `REMOTE_SUPABASE_SECRET_KEY` for privileged RPC / database execution.
- `REMOTE_SERVICE_API_KEY` for routes that allow `AuthMethod.SERVICE_API_KEY`.
- `UPSTASH_REDIS_URL` / `UPSTASH_REDIS_TOKEN` for user API key auth caching.
- `OPENAI_API_KEY`, `OPENAI_CHAT_MODEL`, and optional `OPENAI_BASE_URL`.
- `SAGEMAKER_ENDPOINT_NAME` plus AWS credentials for hybrid search and embedding.
- Feature-specific entries such as Cognito, LangGraph, TIDAS storage, national-carbon cache, and `embedding_ft` timeout knobs are grouped in `supabase/.env.example`.

Credential contract:

- `REMOTE_SERVICE_API_KEY` / `SERVICE_API_KEY` are custom function-level shared secrets. They are not Supabase client credentials.
- `USER_API_KEY` is only a request credential. It can authenticate a function call, but it cannot replace `REMOTE_SUPABASE_SECRET_KEY` for RPC calls made from the function runtime.
- JWT validation and user-api-key sign-in flows must use publishable keys.
- Supabase secret keys are reserved for privileged Supabase execution paths and must never be exposed to browser clients.
- Keep `REMOTE_SUPABASE_URL`, `REMOTE_SUPABASE_PUBLISHABLE_KEY`, and `REMOTE_SUPABASE_SECRET_KEY` from the same Supabase project. A mismatched or stale secret key causes local RPC calls to fail with `Invalid API key` after request authentication succeeds.

### 2. HTTP test env (repo root `.env`)

`test.example.http` reads variables from repository root `.env`. Start from the checked-in HTTP-only template:

```bash
cp .env.example .env
```

This root `.env` is only for local HTTP clients and request collections. It should contain endpoint URLs, request credentials, and request ids such as:

- `LOCAL_ENDPOINT` / `REMOTE_ENDPOINT`
- `X_REGION`
- `USER_API_KEY`
- `USER_JWT`
- `SERVICE_API_KEY`
- LCA request ids such as `LCA_PROCESS_ID`, `LCA_IMPACT_ID`, `LCA_JOB_ID`, and `LCA_RESULT_ID`
- TIDAS import request ids and artifact metadata

Do not put `REMOTE_SUPABASE_SECRET_KEY`, `REMOTE_SUPABASE_PUBLISHABLE_KEY`, OpenAI keys, AWS keys, Redis credentials, or other function runtime secrets in the repository root `.env`.

## Local Development

### Start the local test environment

Start the local Supabase stack first. This provides the local gateway at `LOCAL_ENDPOINT` and is required before `npm start` can serve functions:

```bash
./node_modules/.bin/supabase start
```

Typical local endpoints:

- API URL: `http://127.0.0.1:54321`
- Functions URL: `http://127.0.0.1:54321/functions/v1`
- Studio URL: `http://127.0.0.1:54323`
- DB URL: `postgresql://postgres:postgres@127.0.0.1:54322/postgres`

Serve Edge Functions in another terminal:

```bash
npm start
```

`npm start` is equivalent to:

```bash
./node_modules/.bin/supabase functions serve \
  --env-file ./supabase/.env.local \
  --import-map ./supabase/functions/deno.json \
  --no-verify-jwt
```

Stop the local stack when finished:

```bash
./node_modules/.bin/supabase stop
```

The repository serves with `--no-verify-jwt` by design. Gateway JWT verification is disabled for both local and remote deploys; each function must still run its own `authenticateRequest` authorization path.

### Deploy Edge Functions

Authenticate the Supabase CLI when needed:

```bash
./node_modules/.bin/supabase login
```

Deploy to the persistent `dev` project (`fotofiyqnuyvgtotswie`) from the Git `dev` line or a reviewed PR branch:

```bash
npm run deploy:dev -- flow_hybrid_search process_hybrid_search lifecyclemodel_hybrid_search
```

Deploy to the production `main` project (`qgzvkongdjqiiamzbbts`) only as part of the `dev -> main` promote flow:

```bash
npm run deploy:main -- flow_hybrid_search process_hybrid_search lifecyclemodel_hybrid_search
```

The deploy script pins the Supabase CLI version from `package.json`, sets the target `--project-ref`, disables gateway JWT verification with `--no-verify-jwt`, and passes `--import-map ./supabase/functions/deno.json`.

Recommended deploy workflow:

1. Validate locally with `npm run lint`, `npm run check`, and targeted smoke requests.
2. Confirm the target project already has the required runtime secrets.
3. Deploy named functions only. Avoid omitting function names or using `--prune` unless the intention is to deploy/delete the whole remote function set.
4. Smoke the deployed endpoint through `test.example.http` or equivalent curl requests.
5. Record any deployment or smoke-test outcome on the PR.

Do not patch remote secrets as part of normal function deployment. With this repository's pinned Supabase CLI, remote function secrets are managed separately through the Supabase Dashboard or explicit `supabase secrets` operations such as:

```bash
./node_modules/.bin/supabase secrets list --project-ref <project-ref>
./node_modules/.bin/supabase secrets set KEY=value --project-ref <project-ref>
```

Treat `supabase secrets set --env-file ...` as a credential operation, not as a deploy shortcut. It can write many values at once, so use it only with an explicitly reviewed secret file and target project.

## Local Test

### Quick smoke test

```bash
set -a
. ./.env
set +a

curl -i --location --request POST "$LOCAL_ENDPOINT/process_hybrid_search" \
  --header "Authorization: Bearer $USER_API_KEY" \
  --header 'Content-Type: application/json' \
  --data '{"query":"硅酸盐水泥"}'
```

### Request collection

See `test.example.http` for local and remote examples. Treat it as a supporting artifact for concrete payloads rather than a canonical AI contract doc. It currently includes:

- `flow_hybrid_search`
- `process_hybrid_search`
- `lifecyclemodel_hybrid_search`
- `app_dataset_verify_remote`
- `app_dataset_review_submit_gate`
- `app_dataset_review_submit_jobs`
- `app_worker_jobs`
- `ai_suggest`
- `lca_solve` / `lca_jobs` / `lca_results`
- `lca_query_results`
- `lca_contribution_path` / `lca_contribution_path_result`
- `import_tidas_package` / `tidas_package_jobs`

### TIDAS package artifact download contract

`tidas_package_jobs` returns package artifacts with backward-compatible download fields:

- `signed_download_url` is present only when the artifact is `ready`, not expired, not deleted, has a valid storage path, and storage can create a signed URL.
- `download_status` is one of `available`, `not_ready`, `expired`, `deleted`, `object_missing`, `storage_path_invalid`, or `signed_url_failed`.
- `download_error_code` is `null` for `available`; stable unavailable codes include `PACKAGE_ARTIFACT_EXPIRED`, `PACKAGE_ARTIFACT_DELETED`, `PACKAGE_ARTIFACT_OBJECT_MISSING`, `PACKAGE_ARTIFACT_STORAGE_PATH_INVALID`, `PACKAGE_ARTIFACT_NOT_READY`, `PACKAGE_ARTIFACT_STALE`, and `PACKAGE_ARTIFACT_SIGNED_URL_FAILED`.

Clients should treat `expired`, `deleted`, and `object_missing` as terminal download states and prompt the user to regenerate or re-upload the package. Job lookup itself still returns HTTP `200` when the authenticated user can read the job; missing jobs, auth failures, and business failures keep their existing top-level status and error-code behavior.

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

1. Run the non-mutating formatting check:

```bash
npm run lint
```

Use `npm run format` only when you intend to rewrite files with Prettier.

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

## Worker Jobs RPC Prerequisite

LCA solve/snapshot/contribution path, TIDAS package import/export, and review-submit orchestration use database-owned `worker_jobs` RPCs for canonical task lifecycle state. The target database must include the `database-engine` worker job contract migrations before these Edge Functions are deployed:

- `public.worker_enqueue_job(...)`
- `public.worker_read_job(...)`
- `public.worker_list_jobs(...)`
- `public.worker_cancel_job(...)`

Retained domain tables such as `lca_jobs`, `lca_result_cache`, `lca_package_jobs`, `lca_package_artifacts`, and `dataset_review_submit_jobs` still carry result/cache/artifact/history metadata, but they are not the user-facing task fact. New LCA solve/snapshot/contribution and TIDAS package import/export submissions enqueue `worker_jobs` directly; the legacy job ids returned by those APIs are compatibility ids carried in worker payloads, not newly inserted `lca_jobs` / `lca_package_jobs` rows. Legacy `lca_enqueue_job` / `lca_package_enqueue_job` must not be used as enqueue fallback. If `LCA_WORKER_JOBS_ENABLED=false`, `TIDAS_PACKAGE_WORKER_JOBS_ENABLED=false`, or `WORKER_JOBS_CUTOVER_ENABLED=false`, new worker-owned submissions fail closed with `legacy_queue_disabled` / `LEGACY_QUEUE_DISABLED` instead of writing to the legacy queue path.

## Review-submit Gate Function Call Pattern

`app_dataset_review_submit_gate` is the Edge API boundary for worker-owned review-submit numerical stability reports. It accepts authenticated `POST` requests, derives the authoritative revision checksum from the persisted `json_ordered` row, and returns normalized gate states for Next:

- `queued` / `running`: HTTP `202`, not submit-ready.
- `passed`: HTTP `200`, submit-ready for the exact dataset revision checksum and policy.
- `blocked` / `stale`: HTTP `409`, not submit-ready; render returned `blockingReasons`.
- `error`: HTTP `502`, worker runtime or backend gate failure.

Request shape:

```json
{
  "table": "processes",
  "id": "<dataset uuid>",
  "version": "01.00.000",
  "action": "ensure",
  "policyProfile": "review_submit_fast.v1",
  "reportSchemaVersion": "review_submit_gate_report.v1"
}
```

Legacy clients may still send `revisionChecksum`, but the function treats it as diagnostic input only. The value passed to `cmd_dataset_review_submit_gate` is always computed server-side from the authorized persisted row.

The function calls database-owned RPC `cmd_dataset_review_submit_gate`; database-engine owns persisted gate run schema, idempotent reuse, stale detection, and final submit-review assertion. Edge and Next must not duplicate worker-owned blocker heuristics. Legacy protocol field names such as `calculatorReport` remain payload contract terms, not repository identity.

`app_dataset_review_submit_jobs` is the user-facing orchestration API for reliable final review submission. It accepts authenticated `POST` requests and returns DB-owned coordinator state. New jobs are linked to `tiangong-lca-worker` `worker_jobs` gate records via `gateWorkerJobId` / `gateWorkerJob`; legacy `gateRunId` remains a compatibility field while the old gate-run path is retired.

- `enqueue`: derives the authoritative revision checksum from persisted `json_ordered`, creates or reuses a DB-owned submit job, and returns the persisted job state.
- `read`: reads a known `reviewSubmitJobId`.
- `read_latest`: derives the current authoritative checksum and reads the latest matching job for the dataset revision.

Job response states map to HTTP status as follows:

- `queued` / `waiting_gate` / `submitting`: HTTP `202`, work is still in progress.
- `submitted`: HTTP `200`, DB final submit completed.
- `blocked` / `stale` / `cancelled`: HTTP `409`, not submit-ready or no longer active.
- `error`: HTTP `502`, backend worker or DB orchestration failed.

`process_dataset_review_submit_jobs` is a service-key-only worker endpoint. It claims DB submit jobs, records `waiting_gate` when the worker gate is not ready, maps terminal blocked/cancelled/failed gate worker states back to the coordinator, and calls DB-owned `cmd_review_submit_from_job` only after the gate worker job has completed with a passed result. Recurring invocation should be enabled only after the database RPC migration and this Edge Function are both deployed.

`app_worker_jobs` is the authenticated task-center API for user-visible `worker_jobs`. It supports `list`, `read`, and `cancel`, calls service-role DB RPCs from Edge, and enforces requester ownership before returning or cancelling a job. It does not expose generic user enqueue; job-specific APIs such as `app_dataset_review_submit_jobs` own enqueue semantics and payload validation.

## LCA Function Call Patterns

- `lca_solve`: `POST` only.
  - optional `data_scope`: `"current_user"` (default), `"open_data"`, `"all_data"`
  - body can combine `data_scope` with normal solve payload, for example `{ "data_scope": "current_user", "demand": { "process_index": 0, "amount": 1.0 } }`
  - snapshot family semantics: all three scopes reuse the same user-enhanced snapshot family, i.e. published data plus the current user's private data
  - root-process semantics stay distinct: `current_user` only accepts current-user processes, `open_data` only accepts published processes, `all_data` accepts published plus current-user processes
  - missing snapshot auto-build is attempted for every `data_scope`
- `lca_jobs`: retained compatibility route, supports `GET` and `POST`.
  - `GET`: `/functions/v1/lca_jobs/{jobId}` or `?job_id=...`
  - `POST`: body `{ "job_id": "<uuid>" }`
- `lca_results`: supports `GET` and `POST`.
  - `GET`: `/functions/v1/lca_results/{resultId}` or `?result_id=...`
  - `POST`: body `{ "result_id": "<uuid>" }`
- `lca_query_results`: `POST` only.
