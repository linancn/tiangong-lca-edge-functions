---
title: edge-functions Validation Guide
docType: guide
scope: repo
status: active
authoritative: false
owner: edge-functions
language: en
whenToUse:
  - when an edge-functions change is ready for local validation
  - when deciding the minimum proof required for runtime, shared-module, test, script, config, or docs changes
  - when writing PR validation notes for tiangong-lca-edge-functions work
whenToUpdate:
  - when the repo gains a new canonical validation command or wrapper
  - when change categories require different minimum proof
  - when deploy, auth-probe, or documentation-governance behavior changes
checkPaths:
  - docs/agents/repo-validation.md
  - .docpact/config.yaml
  - package.json
  - pnpm-lock.yaml
  - pnpm-workspace.yaml
  - .nvmrc
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
lastReviewedAt: 2026-08-26
lastReviewedCommit: 1101463915b1d757f56f13ca742855fcf2b1c3e2
lastReviewedNote: 'Reviewed for Issue #310: Portal R2 Hybrid validation separately proves zero-cost rejection, strict public DTOs, abort/circuit/cache behavior, unchanged login endpoints, and the exact 147-root inventory.'
related:
  - ../../AGENTS.md
  - ../../.docpact/config.yaml
  - ./repo-architecture.md
  - ../../README.md
---

# edge-functions Validation Guide

## Default Baseline

Unless the change is doc-only, the default local baseline is:

```bash
pnpm lint
pnpm check
```

`pnpm check` first requires exact Deno `2.9.5` / bundled TypeScript `6.0.3` plus Node `24.19.0` / pnpm `11.23.0`. It then checks all 147 enabled `supabase/functions/*/index.ts` and `test/*.ts` roots in one shared graph, runs Node contract tests, and executes all 447 Deno behavior tests with only env, read, and loopback-network permissions. Deno is the authoritative compiler; no npm TypeScript package participates.

The current baseline intentionally skips:

- `antchain_*`

If you reactivate or rely on that route family, update the inventory and validation story in the same change. The retired generic non-FT embedding route is intentionally absent, while active `embedding_ft` routes stay covered.

## Validation Matrix

| Change type | Minimum local proof | Additional proof when risk is higher | Notes |
| --- | --- | --- | --- |
| One function entrypoint or nearby handler | `pnpm lint`; `pnpm check`; targeted `deno check --config supabase/functions/deno.json <changed-entry-or-handler>` | use `test.example.http` or an equivalent request to smoke the changed path | For handler-based functions, validate both the entrypoint and the extracted handler file. |
| Shared auth modules | `pnpm lint`; `pnpm check`; targeted `deno check` on `_shared/auth.ts` and directly affected consumers | run `pnpm probe:auth --dry-run`; run a local or remote probe if the change affects credential selection | `gateway_invalid_jwt` and `function_auth_failed` are different failure classes. |
| Command runtime, command handlers, or DB-RPC wrappers | `pnpm lint`; `pnpm check`; targeted `deno check` on changed `_shared/command_runtime/**`, `_shared/commands/**`, `_shared/db_rpc/**`, and at least one direct consumer | run nearby repo tests such as `test/command_runtime_test.ts`, `test/dataset_command_rpc_contract_test.ts`, or `test/review_command_rpc_contract_test.ts` | If the change depends on new SQL or RPC truth, record the `database-engine` follow-up explicitly. |
| Application-wide database Schema cutover | `pnpm lint`; `pnpm check`; the canonical `pnpm test:deno` permission boundary; `test/schema_boundary_contract_test.ts` must pass | compare every literal Edge RPC with the exact database-engine `api` catalog and run focused behavior tests for every replaced direct relation path before mirroring to Next | Shared clients default to `api`; direct core-table access selects `public`; no Edge Data API call selects `private` or a non-core relation. Preserve authorization, DTO, idempotency, terminal-error, and storage-signing behavior while moving persistence behind façades. |
| Data Product closure commands, certificate-bound result builds, TaskSummaryV2 feed, or closure-artifact signing | `pnpm lint`; `pnpm check`; `deno test --allow-env --config supabase/functions/deno.json test/data_product_command_test.ts`; `deno test --allow-env --allow-net=127.0.0.1 --config supabase/functions/deno.json test/data_product_command_http_smoke_test.ts`; targeted `deno check` on `app_data_product_commands`, `_shared/commands/data_product/**`, and `_shared/db_rpc/data_product_commands.ts` | against a local database-engine stack, prove owner/manager and cross-user denial, a v2 build does not double-enqueue its persisted job, feed rows expose no payload/locator/signed URL, closure-check reads expose exactly two locator-free availability summaries, and only the requested XLSX or machine-result manifest is signed from a ready unexpired actor-bound descriptor; also prove strict selector forwarding, semantic filenames, the artifact-expiry safety budget, delayed-signing boundary, stable owner-visible `410`, opaque unavailable/unauthorized `404`, sanitized unexpected-RPC/signing `502`, and recursive locator/credential rejection | Database owns scope normalization, Certificate validity, feed ACL, artifact lifecycle, and artifact authorization. Edge must keep request/descriptor schemas strict, expose only the reviewed public projection, call the two-argument RPC, and keep bucket/object paths and all source error details inside the service-only signing step. The local HTTP smoke must traverse the function handler plus real Supabase SDK PostgREST/Storage transports; unit-only `FakeRpc` proof is insufficient for this boundary. Partition selectors are outside this public endpoint. |
| Portal HMAC or published LCIA wrapper | `pnpm lint`; `pnpm check`; `deno test --allow-env --allow-read --config supabase/functions/deno.json test/portal_hmac_test.ts test/portal_redis_guard_test.ts test/portal_data_product_results_v1_test.ts test/portal_deploy_contract_test.ts`; targeted `deno check` on `portal_data_product_results_v1`, `_shared/portal_hmac.ts`, `_shared/portal_redis_guard.ts`, `_shared/portal_security_event.ts`, and `_shared/redis_client.ts` | use disposable, non-production Upstash and Standard Redis fixtures plus the matching database-engine migration to prove `SET NX EX`, Lua atomicity/recovery count, current/previous rotation, Preview/Production isolation, publishable-only RPC transport, exact DTO validation, 60-second revoke visibility, and unavailable-not-zero behavior; run the pinned CLI source fixture and actual public-path serve probe when Docker is available | HMAC canonical bytes always use the public path; runtime accepts only public and exact CLI-stripped paths. HMAC finishes before exact public-apikey match, Cookie rejection, and the narrow exact legacy-anon Bearer compatibility for pinned CLI `2.106.0`; all other Authorization fails. Redis outage fails closed. Lease defaults to 30 seconds, minimum 20, and covers Redis+upstream+5 seconds. LCIA cache is at most 60 seconds and never decides visibility. Every response/event shares one correlation UUID; exactly one safe non-blocking event records fixed outcomes/backend and no request, identifier, credential, Redis, cache-value, or locator fields. Downstream uses explicit `Content-Profile: api` and the same once-resolved public credential; `sb_secret_*`, `service_role`, artifacts, and service clients remain forbidden. Gateway JWT stays disabled through existing serve/deploy scripts. |
| Portal R2 signed Hybrid runtime | `pnpm lint`; `pnpm check`; `deno test --allow-env --allow-read --config supabase/functions/deno.json test/portal_hmac_test.ts test/portal_redis_guard_test.ts test/portal_hybrid_contract_test.ts test/portal_hybrid_search_v1_test.ts test/portal_deploy_contract_test.ts test/hybrid_search_handler_test.ts test/hybrid_query_utils_test.ts`; targeted `deno check` on `portal_hybrid_search_v1`, `_shared/portal_hybrid_*`, `_shared/portal_public_transport.ts`, `_shared/portal_redis_guard.ts`, `_shared/hybrid_search_kernel.ts`, and `_shared/openai_structured.ts` | after `api.portal_hybrid_search_v1` exists in a disposable/non-production Database, prove exact request/response parity, anonymous 100/200 scope, ranking/evidence/card hydration, candidate uniqueness, 8-second end-to-end abort, circuit threshold/recovery, cache expiry, minute/day/concurrency load, and BFF lexical fallback; run the exact public-path serve probe and disposable Upstash/Standard Redis fixtures when available | Invalid/cross-function HMAC, public transport failure, disabled switch, replay, guard outage, budget, concurrency, and open circuit must produce zero OpenAI/SageMaker/DB calls. The switch enables only for exact lowercase `true`; default is false. Model cache keys are body hashes, values omit the raw query and candidates, and TTL is at most 60 seconds. Downstream is only publishable `api.portal_hybrid_search_v1`, never legacy raw Hybrid RPCs or a service client. Response interpretation is advisory/model-generated; every database item is an exact R1 public card with evidence-backed rank fields. Fixed failures contain no lexical results; the BFF owns fallback. No wildcard CORS or unsafe event field is allowed. Live database/provider proof is explicitly deferred while the façade is absent. |
| Scope-closure Edge provider qualification adapter | `deno test --allow-env --config supabase/functions/deno.json test/scope_closure_edge_qualification_test.ts`; targeted `deno check` on `scripts/scope_closure_edge_qualification.ts`; execute `scripts/run_scope_closure_edge_qualification.sh` twice from a clean exact commit with the same `--run-id` and compare outputs; validate one result with the exact Worker provider-owner aggregator contract | feed the git-tracked adapter to Worker `scripts/run_scope_closure_provider_qualification.sh` with the other owner adapters and isolated Linux provider dependencies when the full provider run is coordinated | The adapter accepts only explicit loopback/non-production qualification configuration, binds `componentSha` to a clean exact checkout, drives the real Edge handler and Supabase SDK against a generated loopback fixture, proves owner/cross-owner/ready/expiry/retry/HEAD/range/direct-object behavior for XLSX and manifest roles, and emits only deterministic locator-free `lcia.scope-closure-provider-owned-result.v1` evidence with `productionMutation=false`. |
| LCI/LCIA release commands, artifact verification, or public release reads | `pnpm lint`; `pnpm check`; `deno test --allow-env --config supabase/functions/deno.json test/lca_release_command_test.ts test/lca_release_results_test.ts`; targeted `deno check` on both release entrypoints | against a local database-engine stack, exercise prepare → upload → finalize → approve → publish → signed readback with a `data_product_manager`, then repeat a mutation and private read with a non-manager | Prove all four profile/format pairs, canonical content-addressed object paths, retryable signed-upload upsert at only the same immutable identity, exact byte/hash checks, actor-role recheck before service finalize, public access both without Authorization and with the matching project publishable/legacy anon Bearer credential, private denial, Calculation Bundle manifest binding/path safety and preview-shard signing, exact five-role LCIA XLSX/CSV + LCI Parquet/CSV + audit ZIP projection, server-derived semantic download filenames, locator removal, and failure before any service mutation. Live deployment is separate proof. |
| Direct review submission, Review Admin quality diagnostic, or legacy Gate/coordinator compatibility | `pnpm lint`; `pnpm check`; targeted `deno check` on `app_dataset_submit_review`, `admin_review_quality_diagnostic`, changed dataset/review command files, and DB-RPC wrappers; run `test/app_dataset_submit_review_test.ts`, `test/admin_review_quality_diagnostic_test.ts`, and `test/dataset_command_rpc_contract_test.ts`. When compatibility code changes, also run the existing Gate, submit-job, worker-job, and coordinator tests | smoke direct submit and diagnostic start/read against a dev environment only after the matching database-engine RPCs and Worker runner exist; separately verify any already queued legacy submit job can drain | New submit traffic must call stable `cmd_review_submit` with no Gate authority. Legacy Process Gate fields may be accepted during the compatibility window but are ignored. The diagnostic accepts no client-selected Review/Process scope, preserves database-owned Review Admin denial, and returns `findings`, `not_evaluable`, and `failed` as informational report states that never disable review actions. |
| Hybrid search, foundation-dataset extraction, `embedding_ft`, or OpenAI shared layer | `pnpm lint`; `pnpm check`; targeted `deno check` on changed entrypoints and shared helpers; run `test/dataset_extraction_worker_test.ts`, `test/foundation_dataset_extraction_test.ts`, `test/embedding_ft_job_test.ts`, `test/embedding_ft_postgres_test.ts`, `test/embedding_vector_test.ts`, `test/hybrid_search_handler_test.ts`, `test/hybrid_query_utils_test.ts`, `test/hybrid_search_request_test.ts`, and `test/hybrid_search_rpc_context_test.ts` when the shared foundation search path changes | on the exact non-production deployment whose database contains the matching v2 RPCs, drain a bounded extraction/embedding batch and smoke all seven routes; cover Contact, FlowProperty, Source, and UnitGroup requests for `tg` plus JWT-backed `my`/`te`; prove state/team context reaches both the initial RPC and threshold fallback, while Process, Flow, and LifecycleModel receive no visibility-only fields; confirm stale extraction identities ACK without writes and invalid table/function/column jobs fail closed; for Postgres client lifecycle changes, aggregate `pg_stat_activity` by the redacted application name, prove connections return after the idle window, and prove Edge response bodies plus queue tables retain zero new connection-slot or terminal failures | Every Hybrid payload must contain one `lexical_weight` and one `semantic_weight`; no second lexical control is allowed. Model defaults and entity-specific query-rewrite prompts live in repo code. Foundation Markdown is deterministic; generated vectors must be exactly 1024-dimensional. Embedding job IDs must use canonical PostgreSQL UUID text but need not carry RFC-classified version/variant bits; malformed text still fails before target evaluation. The embedding worker remains restricted to seven reviewed dataset tables and nine unique schema-qualified function targets: `api.flows_embedding_ft_input`, `private.flows_derivative_rebuild_embedding_input`, `api.processes_embedding_ft_input`, `private.processes_derivative_rebuild_embedding_input`, `api.lifecyclemodels_embedding_ft_input`, `public.contacts_embedding_ft_input`, `public.flowproperties_embedding_ft_input`, `public.sources_embedding_ft_input`, and `public.unitgroups_embedding_ft_input`; structured logs must not retain raw user query text. Each isolate processes its batch sequentially and therefore owns one short-idle, bounded-lifetime Postgres connection; do not widen that pool or raise database queue concurrency to hide connection pressure. Edge validates only field shape and forwards the user JWT; database backfill, team authorization, queue truth, RPC visibility, and HNSW plan proof remain in `database-engine`. |
| AI suggestion enqueue/read boundary | `pnpm lint`; `pnpm check`; `deno test --allow-env --config supabase/functions/deno.json test/ai_suggest_test.ts`; targeted `deno check` on `ai_suggest` and `_shared/ai_worker.ts` | against a non-production database containing `svc_ai_tidas_suggestion_enqueue/read`, enqueue one Process and one Flow, drain them with the Rust `ai-worker`, and poll through Edge to terminal results | Accept only JWT or User API key identities. Enforce the 2 MiB Edge input limit and the matching TIDAS root. Never return enqueue payloads, lease state, internal diagnostics, provider details, or service credentials. Database owns requester scoping and job truth; Worker owns rules, provider calls, and versioned results. |
| LCA solve, queue, result, or scope helpers | `pnpm lint`; `pnpm check`; targeted `deno check` on changed `lca_*` files and `_shared/lca_*` helpers; run `test/lca_snapshot_capabilities_test.ts` plus neighboring scope/queue tests. All-unit query artifact reader changes must run `test/lca_all_unit_query_artifact_test.ts`. Static LCIA contract changes must run `test/lca_static_cache_bundle_contract_test.ts`, `test/lca_snapshot_scope_test.ts`, `test/lca_snapshot_scope_db_test.ts`, `test/lca_snapshot_build_queue_test.ts`, and `test/lca_all_unit_solve_queue_test.ts` with `--allow-read` so raw-manifest hash parity and adversarial locator/evidence drift are covered. For worker_jobs cutover changes also run `test/worker_jobs_cutover_test.ts` and `test/worker_jobs_test.ts` | run `scripts/lca_submit_poll_fetch.sh` when the task explicitly touches the submit, poll, or fetch path; otherwise record why that proof is deferred | Prove omitted/blank `scope` resolves to `full_library`, `data_product` remains distinct, and arbitrary environment/cache labels fail before snapshot lookup or enqueue. `worker_jobs` is the default enqueue path; `LCA_WORKER_JOBS_ENABLED=false` must fail closed instead of using legacy queue fallback. Named private scope rejects old combined-scope hashes and v1 database/union LCIA evidence. Query readers retain historical v1 support and validate v2 index/chunk integrity before returning numeric values. The static source base URL is worker-trusted configuration, never a client field. Domain rows/cache remain result metadata, not task fact. Missing worker_jobs DB-side truth is validated in `database-engine`, not here. |
| TIDAS package import, export, or job paths | `pnpm lint`; `pnpm check`; targeted `deno check` on changed package files and `_shared/tidas_package.ts`; run `deno test --allow-env --config supabase/functions/deno.json test/tidas_package_test.ts test/tidas_package_api_test.ts` when package enqueue behavior changes | use the relevant requests in `test.example.http`; if auth or payload shaping changed, run a local or remote smoke path | JWT and `USER_API_KEY` coverage matters for these routes. `worker_jobs` is the default enqueue path; `TIDAS_PACKAGE_WORKER_JOBS_ENABLED=false` must fail closed instead of using legacy queue fallback. Package domain rows/cache/artifacts stay retained metadata, not task fact. |
| Deploy script, `package.json`, `supabase/config.toml`, or PR contract files | `pnpm lint`; inspect branch, project-ref, import-map, and deploy-flag changes against `AGENTS.md` and `.docpact/config.yaml`; run `pnpm check` if runtime inventory or imports changed | if the task includes a real deploy, record which environment was deployed and which function names were used | Remote deploy proof is not implied by local lint or type-check. Scripted deploys should resolve imports through `supabase/functions/deno.json`. |
| Auth probe tooling | `pnpm lint`; `node scripts/probe-functions-auth.cjs --help`; `pnpm probe:auth --dry-run` | run `pnpm probe:auth --remote` or `--local` when the task explicitly includes live probe validation | Dry-run is the safe default when you only changed classification or selection logic. |
| Repo tests only | `pnpm lint`; `pnpm check`; targeted `deno check --config supabase/functions/deno.json <changed-test-file>` | run neighboring tests that cover the same shared module or function family | This repo keeps Deno tests in `test/**`, not under each function folder. |
| Repo docs or docpact config only | `scripts/docpact validate-config --root . --strict`; `scripts/docpact lint --root . --worktree --mode enforce` | perform scenario-based route checks for the affected intent surface | Refresh review metadata when governed docs change without code changes. |

## Auth And Probe Notes

Facts that matter:

- local serve uses `--no-verify-jwt`
- scripted remote deploys also use `--no-verify-jwt`
- scripted remote deploys pass `supabase/functions/deno.json` as the Supabase CLI import map
- runtime auth still happens inside functions, primarily through `supabase/functions/_shared/auth.ts`
- `scripts/probe-functions-auth.cjs` is the fastest way to separate gateway rejection from runtime-auth rejection

Useful low-risk commands:

```bash
node scripts/probe-functions-auth.cjs --help
pnpm probe:auth --dry-run
pnpm probe:auth --remote --only lca_
```

## Docpact Governance Notes

The repo's machine-readable governance source is `.docpact/config.yaml`.

That means:

- governed-doc rules, routing intents, ownership boundaries, and freshness live in `.docpact/config.yaml`
- `.github/workflows/ai-doc-lint.yml` is manual-dispatch fallback and should delegate to the same local docpact gate
- retained explanatory docs stay in `AGENTS.md`, this file, `repo-architecture.md`, `README.md`, and the PR templates

Do not recreate deleted `ai/*` files under a new name. Keep deterministic facts in config and explanatory material in retained source docs.

## Remote Deploy Notes

Remote deploy proof is separate from local type-check proof.

If the task includes a real deploy, record:

1. which command ran
2. which target environment was used
3. which function names were deployed
4. which smoke proof was run after deploy, if any

If no deploy happened, say so explicitly in the PR note.

## Database Boundary Notes

When a runtime change depends on database truth:

- runtime validation stays here
- migration, RPC, or persistent branch proof stays in `database-engine`

Common examples:

- missing `lca_enqueue_job`
- changed command RPC signature or policy behavior
- changed published-state or `state_code` semantics

## Minimum PR Note Quality

A good PR note for this repo should say:

1. which local commands ran
2. which targeted `deno check` or repo test files were exercised
3. whether any deploy or probe proof was performed or deferred
4. whether any required database-side proof lives in `database-engine`

## Local Docpact Push Gate

Install the versioned local hook once per checkout:

```bash
./scripts/install-git-hooks.sh
```

The `pre-push` hook runs `scripts/docpact-gate.sh`, which delegates CLI lookup to `scripts/docpact` and performs strict config validation plus enforced lint before the push leaves the machine. It then runs non-mutating `pnpm lint` and canonical `pnpm check` as the local test gate, and aborts if the lint step changes the working tree before `pnpm check`. The wrapper checks `DOCPACT_BIN`, Cargo install locations, Homebrew install locations, and then `PATH`, so local agent shells should not fail only because bare `docpact` is unavailable. The default comparison base is `origin/dev` for routine branches and `origin/main` for promote or hotfix branches. Override it for unusual stacks with `DOCPACT_BASE_REF=<ref>` or `scripts/docpact-gate.sh --base <ref>`. The gate writes its detailed report to a temporary file so normal pushes do not create `.docpact/runs/` artifacts. The GitHub `CI` workflow is manual-dispatch only rather than an ordinary push-triggered test runner.
