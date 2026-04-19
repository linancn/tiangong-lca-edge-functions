# TianGong-LCA-Edge-Functions

## Overview

Supabase Edge Functions for LCA search, embedding, and solving workflows.

- Runtime: Supabase Edge Runtime (Deno 2.1.x)
- Functions root: `supabase/functions`
- Local serve command: `npm start`

## AI Docs Entry

For the AI-facing checked-in contract layer, start with:

1. `AGENTS.md`
2. `ai/repo.yaml`
3. `ai/task-router.md`
4. `ai/validation.md`
5. `ai/architecture.md`

These files are the low-token entry path for repo ownership, branch and deploy rules, validation, and cross-repo boundaries. `README.md` remains the human-oriented setup and operations guide.

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

See `test.example.http` for local and remote examples, including:

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
- Update `AGENTS.md` for AI workflow/dependency/process changes.

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
  - optional `data_scope`: `"current_user"` (default), `"open_data"`, `"all_data"`
  - mode `process_all_impacts`: body `{ "mode": "process_all_impacts", "data_scope": "current_user", "process_id": "<uuid>" }`
  - mode `processes_one_impact`: body `{ "mode": "processes_one_impact", "data_scope": "current_user", "process_ids": ["<uuid>"], "impact_id": "<uuid>" }`
  - mode `processes_one_impact` hotspot ranking: body `{ "mode": "processes_one_impact", "data_scope": "all_data", "impact_id": "<uuid>", "top_n": 20, "sort_by": "absolute_value", "sort_direction": "desc" }`
  - all three scopes reuse the same user-enhanced snapshot family
  - request-time process filtering stays distinct: `current_user = current-user processes`, `open_data = published processes`, `all_data = published + current-user processes`
  - missing snapshot auto-build is attempted for every `data_scope`
- `lca_contribution_path`: `POST` only.
  - optional `data_scope`: `"current_user"` (default), `"open_data"`, `"all_data"`
  - body `{ "process_id": "<uuid>", "impact_id": "<uuid>", "amount": 1.0, "options": { "max_depth": 4, "top_k_children": 5, "cutoff_share": 0.01, "max_nodes": 200 } }`
  - returns `queued | in_progress | cache_hit`
  - all three scopes reuse the same user-enhanced snapshot family
  - request-time root-process filtering stays distinct: `current_user = current-user processes`, `open_data = published processes`, `all_data = published + current-user processes`
  - missing snapshot auto-build is attempted for every `data_scope`
- `lca_contribution_path_result`: supports `GET` and `POST`.
  - `GET`: `/functions/v1/lca_contribution_path_result/{resultId}` or `?result_id=...`
  - `POST`: body `{ "result_id": "<uuid>" }`
- `import_tidas_package`: `POST` only.
  - auth: supports both `Authorization: Bearer <USER_JWT>` and `Authorization: Bearer <USER_API_KEY>`
  - action `prepare_upload`: body `{ "action": "prepare_upload", "filename": "example.zip", "byte_size": 123, "content_type": "application/zip" }`
  - action `enqueue`: body `{ "action": "enqueue", "job_id": "<uuid>", "source_artifact_id": "<uuid>", "artifact_sha256": "<sha256-or-null>", "artifact_byte_size": 123, "filename": "example.zip", "content_type": "application/zip" }`
- `tidas_package_jobs`: supports `GET` and `POST`.
  - auth: supports both `Authorization: Bearer <USER_JWT>` and `Authorization: Bearer <USER_API_KEY>`
  - `GET`: `/functions/v1/tidas_package_jobs/{jobId}` or `?job_id=...`
  - `POST`: body `{ "job_id": "<uuid>" }`

## TIDAS Package Import API

The async TIDAS package import flow uses the edge-function base URL:

- local: `http://127.0.0.1:54321/functions/v1`
- remote: `<your-edge-functions-url>/functions/v1`

The supported auth headers are:

- browser JWT: `Authorization: Bearer <USER_JWT>`
- user API key: `Authorization: Bearer <USER_API_KEY>`

Recommended flow:

1. Call `POST /import_tidas_package` with `{"action":"prepare_upload", ...}` to create the import job and receive a signed upload target.
2. Upload the ZIP bytes with the returned signed-upload fields.
   - Preferred: use `upload.bucket`, `upload.path`, and `upload.token` with the Supabase Storage signed-upload helper.
   - Optional convenience: if `upload.signed_url` is non-null, clients may upload directly to that URL.
3. Call `POST /import_tidas_package` with `{"action":"enqueue", ...}` to mark the source artifact ready and enqueue the async worker job.
4. Poll `GET /tidas_package_jobs/{job_id}` until the job reaches `completed` or `failed`.

Example `prepare_upload` request:

```bash
curl -i --location --request POST "${BASE_URL}/import_tidas_package" \
  --header 'Content-Type: application/json' \
  --header "Authorization: Bearer ${USER_API_KEY}" \
  --header 'X-Idempotency-Key: tidas-import-demo-prepare-001' \
  --data '{
    "action": "prepare_upload",
    "filename": "example-package.zip",
    "byte_size": 123456,
    "content_type": "application/zip"
  }'
```

Example upload with the Supabase Storage signed-upload helper:

```ts
const { error } = await supabase.storage
  .from(upload.bucket)
  .uploadToSignedUrl(upload.path, upload.token, file, {
    contentType: upload.content_type,
    upsert: true,
  });
```

Optional direct upload when `upload.signed_url` is present:

```bash
curl -i --request PUT "${SIGNED_URL}" \
  --header 'Content-Type: application/zip' \
  --data-binary @./example-package.zip
```

Example `enqueue` request:

```bash
curl -i --location --request POST "${BASE_URL}/import_tidas_package" \
  --header 'Content-Type: application/json' \
  --header "Authorization: Bearer ${USER_API_KEY}" \
  --data '{
    "action": "enqueue",
    "job_id": "<job-id-from-prepare-upload>",
    "source_artifact_id": "<source-artifact-id-from-prepare-upload>",
    "artifact_sha256": "<optional-sha256>",
    "artifact_byte_size": 123456,
    "filename": "example-package.zip",
    "content_type": "application/zip"
  }'
```

Example job polling:

```bash
curl -i --location --request GET "${BASE_URL}/tidas_package_jobs/<job-id>" \
  --header "Authorization: Bearer ${USER_API_KEY}"
```

Notes:

- The edge function keeps the existing browser JWT flow unchanged; API-key clients use the same prepare-upload, direct-upload, enqueue, and poll contract.
- JWT callers do not require Redis; the Redis-backed path is only used for `USER_API_KEY` bearer authentication.
- Import validation now happens asynchronously in the calculator worker after enqueue, and validation failures are surfaced through the import report artifact linked from `tidas_package_jobs`.

## LCA Minimal Integration Script (submit -> poll -> fetch)

```bash
USER_JWT="<your-user-jwt>" \
DEMAND_MODE=single \
PROCESS_INDEX=0 \
AMOUNT=1 \
./scripts/lca_submit_poll_fetch.sh
```

```bash
USER_API_KEY="<base64-email-password>" \
DEMAND_MODE=single \
PROCESS_INDEX=0 \
AMOUNT=1 \
./scripts/lca_submit_poll_fetch.sh
```

```bash
USER_JWT="<your-user-jwt>" \
DEMAND_MODE=all_unit \
./scripts/lca_submit_poll_fetch.sh
```

Optional envs:

- `BASE_URL` (default `http://127.0.0.1:54321/functions/v1`)
- `DEMAND_MODE` (`single` or `all_unit`, default `single`)
- `TIMEOUT_SEC` (default `120`)
- `POLL_INTERVAL_SEC` (default `1`)
- `IDEMPOTENCY_KEY` (optional; auto-generated by default)
- `PROCESS_INDEX` / `AMOUNT` (used only when `DEMAND_MODE=single`)
- `UNIT_BATCH_SIZE` (optional; used only when `DEMAND_MODE=all_unit`)
- auth: set one of `USER_JWT` or `USER_API_KEY`

## Remote Config & Deploy

### CLI baseline

- 标准 CLI 版本固定为 `supabase@2.85.0`。
- 远端部署统一使用仓库脚本，不要直接依赖裸 `npx supabase` 的隐式版本解析。
- 标准部署入口：
  - `npm run deploy:dev -- <function-name> [more-function-names...]`
  - `npm run deploy:main -- <function-name> [more-function-names...]`
- 这两个脚本都会自动：
  - 使用固定的 `supabase@2.85.0`
  - 读取仓库内登记的 `dev` / `main` project ref
  - 固定追加 `--no-verify-jwt`

部署前需要先满足以下其一：

- 已执行 `npx --yes supabase@2.85.0 login`
- 或已显式提供 `SUPABASE_ACCESS_TOKEN`

### Push secrets

```bash
# Dangerous: make sure you are targeting the correct project before overwriting secrets.
npx --yes supabase@2.85.0 secrets set --env-file ./supabase/.env.local --project-ref fotofiyqnuyvgtotswie
npx --yes supabase@2.85.0 secrets set --env-file ./supabase/.env.local --project-ref qgzvkongdjqiiamzbbts
```

### Deploy examples

把同一批函数部署到 `dev` 时，把下面命令里的 `deploy:main` 改成 `deploy:dev` 即可。

### Redeply

整体重新部署

```shell
set -euo pipefail && \
for fn in $(find supabase/functions -mindepth 1 -maxdepth 1 -type d \
  ! -name '_shared' \
  ! -name 'antchain_get_local_ip' \
  ! -name 'antchain_sign_request' \
  ! -name 'embedding_ft_local' \
  -exec basename {} \; | sort); do
  echo "==> deploy $fn"
  supabase functions deploy "$fn" \
    --project-ref fotofiyqnuyvgtotswie \
    --no-verify-jwt \
    --use-api \
    --import-map supabase/functions/deno.json
done
```

#### Search Functions

```bash
npm run deploy:main -- flow_hybrid_search process_hybrid_search lifecyclemodel_hybrid_search
```

#### LCA Functions

```bash
npm run deploy:main -- lca_solve lca_jobs lca_results lca_query_results lca_contribution_path lca_contribution_path_result
```

#### Embedding Functions

```bash
npm run deploy:main -- embedding_ft webhook_process_embedding_ft webhook_model_embedding_ft webhook_flow_embedding_ft
```

#### Data Operation Functions

```bash
npm run deploy:main -- update_data
```

#### Cognito Functions

```bash
npm run deploy:main -- sign_up_cognito change_password_cognito change_email_cognito
```

#### AI Related Functions

```bash
npm run deploy:main -- ai_suggest
```

#### Antchain Related Functions (not enabled)

```bash
# npm run deploy:main -- antchain_request_process_data antchain_sign_request antchain_run_antchain_calculation
# npm run deploy:main -- antchain_get_local_ip antchain_create_calculation antchain_query_calculation_status antchain_query_calculation_results
```
