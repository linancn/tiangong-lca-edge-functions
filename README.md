# TianGong-LCA-Edge-Functions

## Overview

Supabase Edge Functions for LCA search, embedding, and solving workflows.

- Runtime: Supabase Edge Runtime (Deno 2.1.x)
- Functions root: `supabase/functions`
- Local serve command: `npm start`

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
- `REMOTE_SERVICE_API_KEY`
- `UPSTASH_REDIS_URL`
- `UPSTASH_REDIS_TOKEN`

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
supabase functions serve --env-file ./supabase/.env.local --no-verify-jwt
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

2. Run minimal checks for affected files:

```bash
deno check --config supabase/functions/deno.json <changed-file>
```

3. Keep docs synced:

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

## Remote Config

```bash
npx supabase login

## Dangerous: make sure you are in the correct project context before running the following command, as it will overwrite secrets in the target project.
npx supabase secrets set --env-file ./supabase/.env.local --project-ref qgzvkongdjqiiamzbbts
```

### Search Functions

```bash
npx supabase functions deploy flow_hybrid_search --project-ref qgzvkongdjqiiamzbbts --no-verify-jwt
npx supabase functions deploy process_hybrid_search --project-ref qgzvkongdjqiiamzbbts --no-verify-jwt
npx supabase functions deploy lifecyclemodel_hybrid_search --project-ref qgzvkongdjqiiamzbbts --no-verify-jwt
```

### LCA Functions

```bash
npx supabase functions deploy lca_solve --project-ref qgzvkongdjqiiamzbbts --no-verify-jwt
npx supabase functions deploy lca_jobs --project-ref qgzvkongdjqiiamzbbts --no-verify-jwt
npx supabase functions deploy lca_results --project-ref qgzvkongdjqiiamzbbts --no-verify-jwt
npx supabase functions deploy lca_query_results --project-ref qgzvkongdjqiiamzbbts --no-verify-jwt
npx supabase functions deploy lca_contribution_path --project-ref qgzvkongdjqiiamzbbts --no-verify-jwt
npx supabase functions deploy lca_contribution_path_result --project-ref qgzvkongdjqiiamzbbts --no-verify-jwt
```

### Embedding Functions

```bash
# npx supabase functions deploy embedding --project-ref qgzvkongdjqiiamzbbts --no-verify-jwt
# npx supabase functions deploy webhook_flow_embedding --project-ref qgzvkongdjqiiamzbbts --no-verify-jwt
# npx supabase functions deploy webhook_process_embedding --project-ref qgzvkongdjqiiamzbbts --no-verify-jwt
# npx supabase functions deploy webhook_model_embedding --project-ref qgzvkongdjqiiamzbbts --no-verify-jwt

npx supabase functions deploy embedding_ft --project-ref qgzvkongdjqiiamzbbts --no-verify-jwt

npx supabase functions deploy webhook_process_embedding_ft --project-ref qgzvkongdjqiiamzbbts --no-verify-jwt
npx supabase functions deploy webhook_model_embedding_ft --project-ref qgzvkongdjqiiamzbbts --no-verify-jwt
npx supabase functions deploy webhook_flow_embedding_ft --project-ref qgzvkongdjqiiamzbbts --no-verify-jwt
```

### Data Operation Functions

```bash
npx supabase functions deploy update_data --project-ref qgzvkongdjqiiamzbbts --no-verify-jwt
```

### Cognito Functions

```bash
npx supabase functions deploy sign_up_cognito --project-ref qgzvkongdjqiiamzbbts --no-verify-jwt
npx supabase functions deploy change_password_cognito --project-ref qgzvkongdjqiiamzbbts --no-verify-jwt
npx supabase functions deploy change_email_cognito --project-ref qgzvkongdjqiiamzbbts --no-verify-jwt
```

### AI Related Functions

```bash
npx supabase functions deploy ai_suggest --project-ref qgzvkongdjqiiamzbbts --no-verify-jwt
```

### Antchain Related Functions (not enabled)

```bash
# npx supabase functions deploy antchain_request_process_data --project-ref qgzvkongdjqiiamzbbts --no-verify-jwt
# npx supabase functions deploy antchain_sign_request --project-ref qgzvkongdjqiiamzbbts --no-verify-jwt
# npx supabase functions deploy antchain_run_antchain_calculation --project-ref qgzvkongdjqiiamzbbts --no-verify-jwt
# npx supabase functions deploy antchain_get_local_ip --project-ref qgzvkongdjqiiamzbbts --no-verify-jwt
# npx supabase functions deploy antchain_create_calculation --project-ref qgzvkongdjqiiamzbbts --no-verify-jwt
# npx supabase functions deploy antchain_query_calculation_status --project-ref qgzvkongdjqiiamzbbts --no-verify-jwt
# npx supabase functions deploy antchain_query_calculation_results --project-ref qgzvkongdjqiiamzbbts --no-verify-jwt
```
