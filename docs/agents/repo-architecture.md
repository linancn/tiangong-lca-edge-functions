---
title: edge-functions Architecture Notes
docType: guide
scope: repo
status: active
authoritative: false
owner: edge-functions
language: en
whenToUse:
  - when you need a compact mental model of the repo before editing runtime code, shared helpers, tests, or deploy tooling
  - when deciding which function family or shared module owns a behavior change
  - when auth, command-runtime, LCA, TIDAS, or embedding hotspots are mentioned without file paths
whenToUpdate:
  - when major repo paths or hotspot families change
  - when shared runtime boundaries move
  - when deploy or validation architecture changes enough to make this map misleading
checkPaths:
  - docs/agents/repo-architecture.md
  - .docpact/config.yaml
  - package.json
  - pnpm-lock.yaml
  - pnpm-workspace.yaml
  - .nvmrc
  - .tool-versions
  - deno.json
  - supabase/config.toml
  - supabase/functions/**
  - test/**
  - scripts/**
  - test.example.http
  - .github/workflows/**
  - .github/PULL_REQUEST_TEMPLATE/**
  - .githooks/pre-push
  - scripts/docpact
  - scripts/docpact-gate.sh
  - scripts/install-git-hooks.sh
lastReviewedAt: 2026-08-31
lastReviewedCommit: f2cbab255467e1e9556526beb8c7b3fa1ca52ffd
lastReviewedNote: 'Reviewed for Edge #355: the legacy compatibility decoder requires non-empty string email/password fields before generic lazy Redis can be selected; malformed object/array bearers remain Redis-free.'
related:
  - ../../AGENTS.md
  - ../../.docpact/config.yaml
  - ./repo-validation.md
  - ../../README.md
---

# edge-functions Architecture Notes

## Repo Shape

This repo is organized around Edge Function families plus a shared runtime layer under `supabase/functions/_shared`.

Shared Supabase clients default database operations to `api`. Every direct relation access selects `public` explicitly and is limited to the nine core entity tables. Worker, identity, review, LCA, TIDAS, and Data Product internal state is consumed only through database-owned capability façades; Edge never selects `private` through the Data API.

## Stable Path Map

| Path group | Stability | Why it matters |
| --- | --- | --- |
| `supabase/functions/<name>/index.ts` | stable | default Edge Function entrypoint; baseline `pnpm check` includes every enabled `index.ts` root in one bounded shared Deno graph |
| `supabase/functions/<name>/handler.ts` | stable | larger routes sometimes split real logic here while `index.ts` stays thin |
| `supabase/functions/portal_r0_hmac_verify_v1/**` and `_shared/portal_r0_*` | disposable | non-business EdgeOne Web Crypto/Supabase Deno interoperability fixture with R0-only HMAC, publishable-key, Redis, namespace, receipt, local-test, and live Preview deployment contracts |
| `supabase/functions/_shared/auth.ts` | stable | central claims-first JWT assurance, minimal principal, explicit fresh-user, and lazy legacy credential-selection logic |
| `supabase/functions/_shared/portal_hmac.ts`, `portal_redis_guard.ts`, and the Portal adapter in `redis_client.ts` | stable | Portal-only raw-body request verification, explicitly isolated provider credentials, replay protection, atomic route budget, concurrency lease, and hash-key cache behavior without generic Redis fallback |
| `supabase/functions/_shared/portal_public_transport.ts` | stable | dedicated current-project publishable-key resolution, platform-only current-project URL, exact inbound/legacy-anon transport, Cookie rejection, and bounded raw-byte reader shared by signed Portal routes |
| `supabase/functions/_shared/portal_security_event.ts` and `portal_hybrid_security_event.ts` | stable | route-specific allowlisted exactly-once Portal events, correlation IDs, fixed rewrite/embedding outcome and bounded-latency fields, and the R2 bounded background logger boundary |
| `supabase/functions/_shared/portal_hybrid_contract.ts` and `portal_hybrid_repository.ts` | stable | strict R2 request/public candidate/Edge response DTOs and the publishable-only `api.portal_hybrid_search_v1` transport |
| `supabase/functions/_shared/portal_hybrid_deadline.ts` | stable | one absolute handler-entry deadline, shared model/database AbortSignal, remaining-time operation caps, and non-blocking bounded cleanup |
| `supabase/functions/_shared/portal_hybrid_provider.ts`, `portal_hybrid_kernel.ts`, and `portal_openai_structured.ts` | stable | strict Portal-only OpenAI/SageMaker/AWS configuration plus non-stored, 256-token, none-reasoning, low-verbosity structured Responses parameters resolved after the kill switch; existing generic kernels remain byte-for-byte unchanged |
| `supabase/functions/_shared/command_runtime/**` | stable | request parsing, actor context, audit payload, and command-handler skeleton |
| `supabase/functions/_shared/commands/**` | stable | dataset, review, membership, notification, and profile command logic |
| `supabase/functions/_shared/db_rpc/**` | stable | thin wrappers over database RPC calls; SQL truth still lives in `database-engine` |
| `supabase/functions/_shared/openai_*.ts`, `hybrid_search_kernel.ts`, and `hybrid_query_utils.ts` | stable | shared abortable OpenAI/SageMaker and query-rewrite kernels used by AI-backed routes without sharing route authorization or database clients |
| `supabase/functions/_shared/ai_worker.ts` | stable | service-role adapter for versioned AI worker enqueue/read database façades |
| `supabase/functions/_shared/lca_*.ts` | stable | scope and snapshot helpers for LCA endpoints |
| `supabase/functions/_shared/tidas_package.ts` | stable | import, export, and diagnostics shaping for TIDAS package flows |
| `test/**` | stable | repo-level Deno tests for functions and shared modules |
| `scripts/**` | stable | exact environment contract, bounded Deno graph inventory, Node contracts, deploy contract, auth probe, and LCA smoke helper |
| `.tool-versions` | stable | exact standalone Deno version shared by local version managers and CI |
| `supabase/config.toml` | stable | local serve and remote edge deploy config; not database schema truth |
| `supabase/functions/deno.json` | stable | Deno config and import map used by local checks and scripted remote deploy bundling |
| `test.example.http` | stable | checked-in smoke request collection for local and remote routes |
| `.github/PULL_REQUEST_TEMPLATE/*.md` | stable | M2 branch-specific PR note shape for feature and promote flows |

## Branch Model In Practice

`tiangong-lca-edge-functions` is an M2 repo:

- Git `dev` is the daily integration trunk
- Git `main` is the promoted release line
- routine feature or fix PRs target `dev`
- promotion PRs target `main`
- `.github/PULL_REQUEST_TEMPLATE/feature-to-dev.md` and `promote-dev-to-main.md` encode the repo-level PR handoff shape

This means branch behavior is part of the repo contract, not just a GitHub UI preference.

## Auth And Deploy Architecture

The authoritative runtime/compiler is Deno `2.1.4` and the actual compiler reported by that runtime is TypeScript `5.6.2`. This matches Supabase CLI `2.116.0` -> Edge Runtime `1.74.3` -> Deno `2.1.4`, with each mapping bound to reviewed upstream source evidence. There is no npm TypeScript or format-plugin compiler sidecar. Exact Node `24.19.0` plus pnpm `11.24.0` remain only because the repository still needs the pinned Supabase CLI, non-mutating Prettier, and Node orchestration/contracts. The 155 current function/test roots fit one shared graph-check batch; the runner partitions only after 200 roots. Canonical validation runs 72 Node contract tests and 502 default Deno behavior tests; the credentialed live Upstash test is opt-in and ignored by default.

The repo intentionally keeps gateway JWT verification off in its standard operator paths:

- local serve: `pnpm start`
- scripted remote deploys: `pnpm deploy:dev`, `pnpm deploy:main`

Both paths use `--no-verify-jwt`.

Scripted remote deploys also pass `supabase/functions/deno.json` as the Supabase CLI import map. Keep shared npm/jsr import mappings there so local `deno check` and server-side Supabase bundling use the same resolution contract.

The real auth boundary is therefore inside runtime code, primarily:

- `supabase/functions/_shared/auth.ts`
- `supabase/functions/_shared/cognito_auth.ts`
- `supabase/functions/_shared/decode_api_key.ts`

Supported runtime auth modes currently include:

- Supabase `JWT`, which defaults to verified claims/JWKS and returns `userId`, optional email, auth method, optional OAuth `clientId`, session ID, and verified claims in a minimal principal
- explicit `fresh_user` Supabase JWT assurance for identity/profile synchronization plus the Cognito email/password bridge routes; it verifies claims first and then performs the online user lookup
- legacy `USER_API_KEY`, which remains a base64 email/password compatibility bearer and resolves generic Redis only after the opaque bearer decodes successfully
- `SERVICE_API_KEY`
- retained Cognito JWT compatibility, which is a separate principal method and cannot satisfy `fresh_user`
- Portal-only `portal-hmac-v1`, which is not a user identity or a substitute for route budgets

JWT, OAuth JWT, service-key, malformed opaque bearer, and Portal traffic never construct the generic Redis client. The legacy cache uses the email-free `auth:legacy-user-api-key:v2:<sha256(email NUL password)>` namespace and no longer writes an `lca_` key. Its Upstash adapter reads only `UPSTASH_REDIS_REST_URL/TOKEN`, the shared Edge/MCP operator source. Portal Redis remains entirely separate under `PORTAL_*`/`PORTAL_R0_*`. Downstream authorization consumes `AuthResult.principal`; the full Supabase `User` object is retained only for explicit `fresh_user` compatibility work.

`scripts/probe-functions-auth.cjs` exists because gateway rejection and runtime-auth rejection are different operational failures.

## Current Function Families

### Command-style app and admin endpoints

These endpoints usually share the same runtime skeleton:

- `supabase/functions/app_dataset_*`
- `supabase/functions/app_review_*`
- `supabase/functions/app_team_*`
- `supabase/functions/app_user_*`
- `supabase/functions/admin_*`

The shared layers that matter most are:

- `supabase/functions/_shared/command_runtime/**`
- `supabase/functions/_shared/commands/**`
- `supabase/functions/_shared/db_rpc/**`

`app_dataset_submit_review` is the review-submission boundary. It accepts only the dataset identity, calls stable database command `cmd_review_submit`, and never starts, polls, or asserts a worker numerical Gate.

`admin_review_quality_diagnostic` is a JWT-authenticated Review Admin route with only `start` and `read` actions. The browser cannot submit Review IDs, Process IDs, or another scope; database RPCs derive the current pending-review scope, enforce Review Admin membership, reuse one active run, and project one or the latest report. Edge returns `clear`, `findings`, `not_evaluable`, and worker `failed` states as information and never translates them into assignment, approval, or rejection guards.

The retired review-submit Gate, coordinator, and job endpoints are not part of the deployed Edge surface. `app_worker_jobs` remains the authenticated task-center API for user-visible jobs; the operator-visible Review Admin diagnostic is read through its dedicated route rather than through generic task-center access.

`app_data_product_commands` is the JWT-only command boundary for Data Product scope-closure checks and result-build requests. It forwards only user scope intent to actor-bound database RPCs; the database derives snapshot, policy, certificate, and artifact-lifecycle bindings. The shared data-product repository preserves the database-owned versioned check/issues/feed projections while explicitly allowlisting the closure-check public DTO, decoding its fixed-order artifact summaries, and recursively rejecting private locator or credential fields. For downloads, the strict public request requires exactly `closure_report_xlsx` or `closure_issue_manifest`, forwards that selector to the database's two-argument actor RPC, and signs only a matching ready, unexpired descriptor. Partition selectors are not part of this public endpoint. Signed URLs are capped at 900 seconds, reserve a clock-skew/signing safety budget before artifact expiry, and use the database-provided semantic filename. Owner-visible expiry maps to a stable `410`, while unavailable, unauthorized, deleted, unready, and integrity-invalid artifacts remain one opaque `404`. Unexpected RPC/PostgREST failures and every Storage signing throw, rejection, malformed result, or SDK error collapse to fixed locator-free `502` responses. The service client may see the private bucket/path solely for the signing step and never returns either field or source error details to the browser. Task feed visibility is database-owned ACL, not a consequence of task-center category or presenter metadata.

### Disposable Portal R0 interoperability route

`portal_r0_hmac_verify_v1` is a non-business, removable proof endpoint for one EdgeOne Preview signer. It accepts the public canonical path `/functions/v1/portal_r0_hmac_verify_v1` and the exact pinned-CLI stripped runtime path while always signing the public path. Raw request bytes, timestamp, 128-bit nonce, method, body hash, key ID, and current/previous HMAC key are verified before its dedicated publishable-key transport, Redis, or JSON. The sole valid body is `{"schemaVersion":"portal.r0-hmac-verify-request.v1"}` and success is the bounded `portal.r0-hmac-redis-receipt.v1` receipt.

The route reads only `PORTAL_R0_*` configuration plus the platform-owned `SUPABASE_PUBLISHABLE_KEYS` registry. Its namespace is `portal:r0:<fixture>:v1`; it cannot name Dev/Main/Production, and R0 never falls back to retained Portal or generic HMAC, publishable, Redis, provider, Supabase, or service variables. Nonce registration is exact `SET NX EX 120`, followed by the reviewed atomic budget/concurrency Lua primitive and synchronous lease cleanup. It has no cache, database, RPC, model, provider, repository, storage, business DTO, event, or logger surface. Every failure is a fixed locator-free receipt.

The generic deploy scripts reject R0. Both dedicated commands verify Main parent, project ref, nondefault/nonpersistent/no-data flags, branch name, Git branch, optional PR, and clean SHA from live CLI JSON. Deploy then requires `FUNCTIONS_DEPLOYED`, `ACTIVE_HEALTHY`, deploy acknowledgement, and future expiry within 24 hours. Cleanup uses its separate acknowledgement and intentionally ignores status, health, and past expiry after identity succeeds, so paused/unhealthy/failed branches still receive the fixed function-delete attempt; delete failure blocks. An absent target in a valid nonempty response is terminal. External cleanup is exact-key and temporary-secret only: the approved shared Upstash database, coordinated source token, and Dev/Main namespaces must remain untouched. Fixed messages never include metadata or tokens.

### Portal signed public LCIA route

`portal_data_product_results_v1` is an additive server-to-server route for the anonymous Portal BFF. It accepts exactly one raw JSON serialization over public `POST /functions/v1/portal_data_product_results_v1` and the exact `/portal_data_product_results_v1` path produced after pinned CLI `2.116.0` strips the public prefix. The raw bytes, body hash, timestamp, 128-bit nonce, method, and public function path are bound by `portal-hmac-v1`; the runtime pathname is never substituted into canonical bytes. Suffixes and cross-function paths fail. The verifier has one current key and an optional previous key only during rotation. Preview/dev and Production/main use separate keys, Redis databases, tokens, and `portal:<environment>:v1` namespaces.

After HMAC succeeds, transport validation reads only `PORTAL_SUPABASE_PUBLISHABLE_KEY`, proves the modern key is present in the platform-owned current-project `SUPABASE_PUBLISHABLE_KEYS` registry, binds database transport only to platform-injected `SUPABASE_URL`, requires an exact constant-time inbound `apikey` match, and rejects every Cookie. Hosted transport is HTTPS and rejects every Authorization. Pinned CLI `2.116.0` maps the matched publishable key into `sb-api-key` and does not inject Authorization; exact local `SUPABASE_URL=http://kong:8000` retains only the older-client exact `SUPABASE_ANON_KEY` Bearer compatibility after the trusted publishable key matches. User, service, and other Bearers fail before Redis. The same once-resolved dedicated key is passed to the public repository; generic and `REMOTE_*` key/URL precedence or indirect helper import is not available.

Redis atomically registers the nonce for 120 seconds and runs one Lua admission operation for minute/day budgets plus a TTL-backed concurrency lease. The Portal adapter reads only `PORTAL_REDIS_*` / `PORTAL_UPSTASH_REDIS_*` provider credentials and never falls back to the generic Redis surface consumed by existing Functions. The lease defaults to 30 seconds, is at least 20 seconds, and must cover Redis plus upstream timeouts with five seconds of recovery margin. Missing configuration, timeout, malformed response, or provider outage fails closed before JSON, cache, or database work. The lease is released in `finally`; its TTL recovers an interrupted isolate and Lua reports only the recovered count. Public-result cache keys contain only the request body hash and expire in at most 60 seconds. This bound ensures direct same-origin BFF traffic rechecks a revoked publication within the visibility SLA; Redis does not decide visibility or authorization.

Upstash's exported `UPSTASH_REDIS_REST_URL/TOKEN` names are the runtime contract for generic Edge/MCP Redis and the operator-source format for the Portal live fixture. The fixture accepts only those two keys from a mode-0600 file and maps them into a single child process as `PORTAL_UPSTASH_REDIS_URL/TOKEN`; long-lived Portal/EdgeOne application secrets remain Portal-prefixed and never fall back to the generic pair. It derives one runtime-compatible test namespace by losslessly base36-encoding a CSPRNG UUIDv4 receipt printed before child startup. Concurrent runs therefore share no replay, budget, lease, cache, startup-cleanup, or final-cleanup key. Interrupted cleanup requires that retained non-secret run ID and deletes only the exact derived keys. Portal application code never loads the credential file.

The route then calls only `api.portal_get_published_lcia_values_v1` with explicit `Content-Profile: api` and the strictly validated dedicated publishable credential. It rejects `sb_secret_*`, JWT credentials, non-project keys, credential-bearing/non-HTTPS remote URLs, user context, service clients, artifacts, and locators. A successful response is the exact bounded `portal.published-lcia-page.v1` DTO. A missing publication is unavailable with zero rows, never numeric zero.

Every request resolves or generates one correlation UUID, returns it as `X-Portal-Correlation-Id`, and invokes exactly one non-blocking `portal.security-event.v1` logger. Its schema includes only route, correlation, mode, cache state, fixed HMAC/transport outcomes, fixed backend class, bounded latency/rows/status/error, current/previous key match, recovered-lease count, and the validated `PORTAL_LCIA_DEPLOYMENT_SHA` or `unknown`. It never falls back to the Hybrid or retired shared SHA. It has no fields for raw request/query, dataset UUIDs, nonce, key ID, body hash, Redis key, cache value, API key, secret, Cookie, or locator. Logger throws, rejections, and never-resolving promises do not change or delay responses.

### Portal signed public Hybrid route

`portal_hybrid_search_v1` is a separate R2 server-to-server route. It reuses the exact R1 HMAC/keyring/path and dedicated project-bound public-apikey/Cookie transport plus the shared OpenAI rewrite and SageMaker embedding kernels, but not the old Hybrid handler's credentials, authentication, service client, raw RPCs, request options, database response, or fallback. The extraction keeps all seven login Hybrid endpoints on their existing generic provider precedence and request/RPC/fallback/response semantics.

The strict signed request contains only schema version, Process/Flow kind, a 512-code-point/2048-byte control-free query, bounded lowercase public filters, and limit at most 20. Filter strings are trimmed and lowercased before their 128-code-point/1024-byte bounds and the transformed filter object receives the 4096-byte aggregate bound, so Unicode lowercase expansion cannot bypass the contract. It has no cursor, state, actor, team, data source, model, weight, threshold, embedding, visitor hash, or notes. HMAC and exact public transport finish before the default-off `PORTAL_HYBRID_ENABLED` switch. Exact false or unset returns before Redis, JSON, OpenAI, SageMaker/AWS, or database configuration is read. Only after exact true does the route require one complete, format-checked `PORTAL_OPENAI_*` / `PORTAL_SAGEMAKER_*` / `PORTAL_AWS_*` configuration and construct the current-project public repository; missing, partial, malformed, unsafe, generic-only, or cross-project key/URL configuration fails before Redis or cost work. The Provider object is then passed explicitly to Portal-only shared kernels. Nonce, independent minute/day budgets, a TTL concurrency lease, and circuit state then finish before JSON or cost work. Redis/guard, budget, concurrency, disabled, circuit, timeout, upstream, and contract failures return fixed locator-free codes. Edge never calls a lexical fallback; the Portal BFF owns that behavior through the separate R1 public façade.

On a model-cache miss, the admitted route starts the provider-explicit OpenAI rewrite and SageMaker embedding of the original bounded query concurrently under one request operation signal inherited from the absolute deadline. Either provider failure aborts its surviving peer before response and lease release. Rewrite output alone supplies the model-generated interpretation and fulltext terms; the multilingual embedding remains exactly 1024-dimensional. Database work waits for both calls. The shared model cache is keyed only by the signed body hash, expires in at most 60 seconds, and contains only bounded model-generated interpretation terms plus the vector. It does not contain the raw user query or any database candidates, so every successful request still calls only `api.portal_hybrid_search_v1` with explicit `Content-Profile: api` and the once-resolved publishable credential. The database owns unioned public scope, stable ranking, public-card hydration, fingerprint, and evidence. Edge validates the exact public DTO, including exhaustive reference, functional-unit, technology, source/license, and public-quality context, adds only `source=model_generated`/`advisory=true` interpretation, and rejects missing/malformed context, raw/private/locator fields, negative distance, evidence drift, duplicate candidates, or more than 20 items.

One absolute deadline starts at handler entry and caps raw-body/HMAC work plus every awaited Redis, OpenAI, SageMaker, public PostgREST, cache-write, circuit-record/reset, and final-response step to its remaining budget. OpenAI, SageMaker, and PostgREST share the deadline's AbortSignal. No operation that resolves after expiry can start downstream model/database work or turn a timed-out request into HTTP 200. Lease release and owned-client close run as bounded detached cleanup and never delay the response; an uncompleted release is recovered by the existing lease TTL. The route sanitizes its final allowlisted `portal.hybrid-security-event.v1`, using only the validated `PORTAL_HYBRID_DEPLOYMENT_SHA` or `unknown`, fixed rewrite/embedding outcomes, and nullable bounded per-stage latency, performs the last deadline decision, and only then schedules exactly one logger invocation in a later macrotask. Success marks both provider stages `succeeded`, cache hits mark both `cache_hit`, early failure distinguishes the failed provider from its aborted peer, and shared-deadline expiry marks pending stages `aborted`. It never falls back to the LCIA or retired shared SHA. Supabase receives the bounded delivery promise through `EdgeRuntime.waitUntil`; local and test runtimes use the same handled macrotask without joining it to the handler promise. Logger throws, rejections, and never-settling promises are absorbed within a fixed delivery window, while the emitted status and error code always describe the actual final response. The event has no query, terms, embedding, model name, endpoint, provider error, identifiers, credentials, Redis data, or locators. The route returns the same correlation UUID in its response and exposes no wildcard CORS header. Live database integration stays deferred until the matching database-engine façade is present in the selected non-production environment.

### Search, embedding, and AI-backed routes

These routes cluster around:

- `flow_hybrid_search`
- `process_hybrid_search`
- `lifecyclemodel_hybrid_search`
- `contact_hybrid_search`
- `flowproperty_hybrid_search`
- `source_hybrid_search`
- `unitgroup_hybrid_search`
- `ai_suggest`
- `embedding_ft`
- `webhook_*_embedding_ft`
- `process_dataset_extraction_jobs`

Important shared helpers:

- `supabase/functions/_shared/ai_worker.ts`
- `supabase/functions/_shared/openai_chat.ts`
- `supabase/functions/_shared/openai_structured.ts`
- `supabase/functions/_shared/hybrid_query_utils.ts`
- `supabase/functions/_shared/hybrid_search_handler.ts`
- `supabase/functions/_shared/foundation_dataset_extraction.ts`
- `supabase/functions/_shared/dataset_extraction_worker.ts`
- `supabase/functions/_shared/embedding_ft_job.ts`
- `supabase/functions/_shared/embedding_ft_postgres.ts`
- `supabase/functions/_shared/embedding_vector.ts`

All seven Hybrid endpoints are thin route configurations over one shared handler. It owns runtime authentication, deterministic query-rewrite prompts, 1024-dimensional SageMaker validation, JWT preservation for `my`/`te`, RPC fallback, response shape, and redacted structured logs. Each route calls its database `hybrid_search_*_v2` RPC and forwards one `lexical_weight` plus `semantic_weight`; no second lexical request control exists. Only the four foundation routes forward the reviewed optional `state_code_filter` and `team_id_filter` fields. Team authorization remains database-owned. The four foundation datasets use deterministic English-heading Markdown extractors and the compact database-owned extraction queue; missing id/version pairs are acknowledged as stale no-ops, while invalid entity/table combinations are terminal failures. The `embedding_ft` worker accepts canonical PostgreSQL UUID text, including imported dataset identities whose version or variant bits are not RFC-classified, because the database owns those identifiers. It accepts only seven reviewed dataset tables and nine unique schema-qualified function targets: `api.flows_embedding_ft_input`, `private.flows_derivative_rebuild_embedding_input`, `api.processes_embedding_ft_input`, `private.processes_derivative_rebuild_embedding_input`, `api.lifecyclemodels_embedding_ft_input`, `public.contacts_embedding_ft_input`, `public.flowproperties_embedding_ft_input`, `public.sources_embedding_ft_input`, and `public.unitgroups_embedding_ft_input`. Request-provided SQL identifiers are never an open dynamic target surface.

Each `embedding_ft` Edge isolate processes one request batch sequentially, so its Postgres.js client is intentionally capped at one connection, closes after 20 idle seconds, and has a 300-second maximum lifetime. The `embedding-ft-edge` application name makes aggregate connection evidence auditable without exposing row identities. A wider default pool or an unbounded idle lifetime can multiply retained connections across isolates and must not be used to accelerate database-owned queue backfill.

The three legacy OpenAI summary webhooks and the generic non-FT embedding worker are retired from the source inventory. The deterministic `webhook_*_embedding_ft` and `embedding_ft` routes remain active and covered by the default validation baseline.

`ai_suggest` is an authenticated asynchronous adapter, not a model runtime. It accepts legacy Process/Flow TIDAS JSON requests, enforces the 2 MiB Edge limit and matching dataset root, and calls the service-only `svc_ai_tidas_suggestion_enqueue/read` database façades. Its public projection contains only requester-scoped job state and the versioned result; queue payloads, lease fields, diagnostics, and provider errors stay private. The database owns durable `worker_jobs`, while the generic Rust `ai-worker` owns rule loading and OpenAI-compatible provider calls. LangGraph is not on this path.

### LCA async job and result routes

This cluster includes:

- `lca_solve`
- `lca_jobs`
- `lca_results`
- `lca_query_results`
- `lca_contribution_path`
- `lca_contribution_path_result`

Shared scope logic lives in:

- `supabase/functions/_shared/lca_process_scope.ts`
- `supabase/functions/_shared/lca_snapshot_scope.ts`

`supabase/functions/_shared/worker_jobs_cutover.ts` owns the handoff from Edge runtime requests to database-owned `worker_jobs`, while `lca_snapshot_capabilities.ts` and `lca_snapshot_build_queue.ts` consume the service-only snapshot read/enqueue façades. The default path enqueues `lca.solve_one`, `lca.solve_all_unit`, `lca.build_snapshot`, and `lca.contribution_path` through `svc_lca_*`/`svc_worker_*` capability RPCs without directly reading or writing internal job, cache, result, or snapshot relations. Setting `LCA_WORKER_JOBS_ENABLED=false` or `WORKER_JOBS_CUTOVER_ENABLED=false` disables new LCA worker submissions and fails closed with `legacy_queue_disabled`; it must not fall back to legacy `lca_enqueue_job`. Edge still owns auth and request normalization only; `database-engine` owns persistence and `tiangong-lca-worker` owns execution.

The public `scope` field on solve, result-query, and contribution-path requests selects a database snapshot family; it is not a deployment-environment label or an arbitrary cache namespace. Edge defaults an omitted or blank value to `full_library`, accepts `data_product` as the only alternate value, rejects every other value before snapshot lookup or enqueue, and carries the same canonical value through candidate lookup, request hashing, cached-job enqueue, and snapshot-build enqueue.

The named `public_plus_owner_draft` calculation scope is a distinct versioned snapshot family. Edge freezes the authenticated actor and exact public-state-100 plus owner-state-0 predicate in a manifest and SHA-256. `team_id` and `review_id` remain collaboration workflow metadata and do not remove an actor-owned state-zero process or flow from the v2 scope; the legacy v1 manifest retains its original null-team/null-review meaning through a different manifest hash. That scope manifest applies only to processes and flows. LCIA method/factor truth is bound separately to the reviewed frontend static-cache manifest: Edge embeds the exact manifest bytes, raw SHA-256, path, and release hashes, but never accepts a client URL, path, or hash; the worker resolves the base URL from trusted configuration. Worker execution must independently enforce request/snapshot v2 and return exact `lca.calculation_evidence.v2` with all four source hashes and a non-empty 25-row `exchange_method_pair` coverage matrix. Every method identity and artifact locator must match the reviewed manifest, every row must have the same pair cardinality, aggregate counts must equal the row sums, and v2 gap-artifact record counts must equal all unmatched, invalid, and unsupported-direction pairs. Solve, query, and contribution-path routes reject v1 database/union evidence, missing evidence, and any source, identity, cardinality, count, status, or artifact drift before returning numeric values. Missing characterization factors are never represented as complete zero impact; raw private-storage gap URLs remain immutable evidence locators rather than browser download links.

`lca_query_results` keeps historical `all-unit-query:v1` matrix reads and consumes `all-unit-query:v2` as a bounded index over Calculation Bundle LCIA chunks. The v2 path verifies the persisted query-index size and SHA-256, keeps child paths inside the referenced bundle, and validates each downloaded gzip chunk's size, SHA-256, process range, record count, method identity, ordering, and finite values before returning a row or hotspot projection. It loads only the covering chunks for selected queries and processes full-hotspot chunks sequentially instead of rebuilding the removed full H matrix.

Data Product package preview shares that strict v1/v2 artifact reader. Historical v1 packages retain inline-matrix compatibility; current v2 packages verify the durable query-index size and SHA-256 and read only the LCIA chunks covering the requested result page and selected impact category. Package preview must not require an inline `h_matrix` from v2 or reconstruct the complete result matrix in Edge.

### TIDAS package flows

This cluster includes:

- `import_tidas_package`
- `export_tidas_package`
- `tidas_package_jobs`

Shared behavior lives in:

- `supabase/functions/_shared/tidas_package.ts`
- `supabase/functions/_shared/redis_client.ts`

The default TIDAS package path uses the four `svc_tidas_package_*` façades for export enqueue, import prepare, import enqueue, and job/artifact projection. Edge shapes upload/download responses but does not directly read or mutate package cache, artifact, or worker relations. Setting `TIDAS_PACKAGE_WORKER_JOBS_ENABLED=false` or `WORKER_JOBS_CUTOVER_ENABLED=false` disables new package worker submissions and fails closed with `LEGACY_QUEUE_DISABLED`; it must not fall back to legacy `lca_package_enqueue_job`. The database preserves compatibility identifiers, canonical worker lifecycle, DTOs, and deleted/expired artifact semantics.

### LCI/LCIA release control plane

`app_lca_release_commands` is the authenticated control-plane boundary for deterministic LCI/LCIA releases. It accepts JWT sessions only; a caller that starts with a TianGong User API key must exchange that key for a user session before invoking the function. Database RPCs re-evaluate the current account's `data_product_manager` role for prepare, approval, publish, readback verification, unpublish, private reads, and Calculation Bundle reads.

The artifact path deliberately has two identities. Actor-bound RPCs authorize the requested release and bind its exact publish-plan hash. The Edge service client then creates retryable signed uploads under a server-derived private object key; upsert is confined to that content-addressed release/plan/profile/format/hash identity. It downloads each of the four TIDAS/ILCD profile ZIPs, verifies byte size and SHA-256, repeats the actor-bound role check, and invokes the service-only finalize RPC. Release clients never receive the Supabase secret/service-role key and cannot select a storage bucket or object key.

Calculation Bundle reads follow the same projection rule. The database returns only the manager-authorized immutable bundle ref and role-bound product download descriptors. Edge accepts historical `tiangong.calculation-bundle.v1` and current `tiangong.calculation-bundle.v2`, downloads the private manifest, verifies its exact size and SHA-256 plus exact durable-schema/content-hash/artifact-count binding, rejects unsafe child paths, and returns short-lived signed URLs for preview shards. It separately validates and signs the fixed LCIA XLSX/CSV, LCI Parquet/CSV, and whole-bundle audit roles with semantic filenames. Raw Worker object URLs and storage locators are never browser download contracts.

`lca_release_results` exposes current or superseded public release metadata, source-Process-to-Model/Result identity projections, and signed artifact downloads without requiring a session. Process projections bind an exact Process UUID/version and return no storage locator. A matching Supabase project publishable key, including the configured legacy anon key, may appear as a Bearer credential on ordinary browser-client requests and remains a public read rather than actor authentication. Any other Authorization header must authenticate successfully, and private release reads remain subject to the database projection's manager check. The endpoint never signs an object until the database returns an authorized bucket/object-key projection. It resolves the authoritative release version and profile before signing, returns a server-derived `downloadFilename`, and binds that same semantic filename into the signed URL rather than exposing the content-addressed object name to browser downloads.

## Database Boundary

This repo consumes database truth but does not own it.

Typical signs the task also belongs in `database-engine`:

- a route depends on a missing RPC such as `worker_enqueue_job`
- command wrappers need new SQL contract or policy behavior
- published-state or `state_code` semantics changed

Fix the runtime here. Fix schema truth there.

## Validation Hotspots

The widest fan-out changes usually touch:

1. `_shared/auth.ts`
2. `_shared/command_runtime/**`
3. `_shared/db_rpc/**`
4. `_shared/openai_*.ts`
5. `scripts/deno-check-all.cjs`
6. `scripts/probe-functions-auth.cjs`

If one of those changes, assume more than one function family is affected.

## Common Misreads

- GitHub default branch `main` is not the daily trunk
- `supabase/config.toml` does not own database schema truth
- `--no-verify-jwt` does not remove runtime auth requirements
- a merged child PR does not finish workspace delivery

## Local Docpact Push Gate

This repository has a versioned local `pre-push` hook under `.githooks/pre-push` that delegates to `scripts/docpact-gate.sh` and then runs non-mutating `pnpm lint` plus canonical `pnpm check`. The hook aborts if the lint step changes the working tree, so generated formatting changes must be reviewed and committed before push. The gate resolves the CLI through `scripts/docpact`, so local agent shells do not need bare `docpact` on `PATH`. The hook is the local guard for docpact config validation, enforced doc-governance linting, and the complete Edge Function type/behavior gate; the GitHub `CI` workflow is manual-dispatch only.
