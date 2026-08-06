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
lastReviewedAt: 2026-08-07
lastReviewedCommit: 02e1aeb99aa7b336ef9009947655d9e69c85ffbc
lastReviewedNote: 'Reviewed for Issue #422 schema cutover: document explicit public/api selection and facade-only access to non-core database state.'
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
| `supabase/functions/<name>/index.ts` | stable | default Edge Function entrypoint; baseline `npm run check` walks enabled `index.ts` files |
| `supabase/functions/<name>/handler.ts` | stable | larger routes sometimes split real logic here while `index.ts` stays thin |
| `supabase/functions/_shared/auth.ts` | stable | central runtime auth and credential-selection logic |
| `supabase/functions/_shared/command_runtime/**` | stable | request parsing, actor context, audit payload, and command-handler skeleton |
| `supabase/functions/_shared/commands/**` | stable | dataset, review, membership, notification, and profile command logic |
| `supabase/functions/_shared/db_rpc/**` | stable | thin wrappers over database RPC calls; SQL truth still lives in `database-engine` |
| `supabase/functions/_shared/openai_*.ts` and `hybrid_query_utils.ts` | stable | shared OpenAI and query-rewrite helpers used by AI-backed routes |
| `supabase/functions/_shared/lca_*.ts` | stable | scope and snapshot helpers for LCA endpoints |
| `supabase/functions/_shared/tidas_package.ts` | stable | import, export, and diagnostics shaping for TIDAS package flows |
| `test/**` | stable | repo-level Deno tests for functions and shared modules |
| `scripts/**` | stable | deno-check inventory, deploy contract, auth probe, and LCA smoke helper |
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

The repo intentionally keeps gateway JWT verification off in its standard operator paths:

- local serve: `npm start`
- scripted remote deploys: `npm run deploy:dev`, `npm run deploy:main`

Both paths use `--no-verify-jwt`.

Scripted remote deploys also pass `supabase/functions/deno.json` as the Supabase CLI import map. Keep shared npm/jsr import mappings there so local `deno check` and server-side Supabase bundling use the same resolution contract.

The real auth boundary is therefore inside runtime code, primarily:

- `supabase/functions/_shared/auth.ts`
- `supabase/functions/_shared/cognito_auth.ts`
- `supabase/functions/_shared/decode_api_key.ts`

Supported runtime auth modes currently include:

- `JWT`
- `USER_API_KEY`
- `SERVICE_API_KEY`

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

`app_dataset_review_submit_gate` is the edge API boundary for dataset review-submit numerical stability checks. It normalizes request and response semantics for Next, derives the authoritative revision checksum from the authorized persisted `json_ordered` row, and calls database-owned RPCs for persisted gate runs. Client-provided revision checksums are compatibility/diagnostic input only. Edge does not own worker blocker heuristics or database schema. `app_dataset_review_submit_jobs` is the user-facing orchestration API for persisted review-submit jobs, and `process_dataset_review_submit_jobs` is the service-key-only worker that advances those jobs after gate results are available. New review-submit jobs use database-owned `worker_jobs` gate records through `gateWorkerJobId` / `gateWorkerJob`; the legacy `gateRunId` path remains compatibility-only until cutover is complete. `app_worker_jobs` is the authenticated task-center API for listing, reading, and cancelling user-visible worker jobs through service-role DB RPCs with Edge ownership checks. `app_dataset_submit_review` remains the direct compatibility path carrying gate assertion metadata for process submit-review so DB truth can reject stale, wrong-policy, wrong-checksum, or blocked gate runs before a review is created.

`app_data_product_commands` is the JWT-only command boundary for Data Product scope-closure checks and result-build requests. It forwards only user scope intent to actor-bound database RPCs; the database derives snapshot, policy, certificate, and artifact-lifecycle bindings. The shared data-product repository preserves the database-owned versioned check/issues/feed projections while explicitly allowlisting the closure-check public DTO, decoding its fixed-order artifact summaries, and recursively rejecting private locator or credential fields. For downloads, the strict public request requires exactly `closure_report_xlsx` or `closure_issue_manifest`, forwards that selector to the database's two-argument actor RPC, and signs only a matching ready, unexpired descriptor. Partition selectors are not part of this public endpoint. Signed URLs are capped at 900 seconds, reserve a clock-skew/signing safety budget before artifact expiry, and use the database-provided semantic filename. Owner-visible expiry maps to a stable `410`, while unavailable, unauthorized, deleted, unready, and integrity-invalid artifacts remain one opaque `404`. Unexpected RPC/PostgREST failures and every Storage signing throw, rejection, malformed result, or SDK error collapse to fixed locator-free `502` responses. The service client may see the private bucket/path solely for the signing step and never returns either field or source error details to the browser. Task feed visibility is database-owned ACL, not a consequence of task-center category or presenter metadata.

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

- `supabase/functions/_shared/openai_chat.ts`
- `supabase/functions/_shared/openai_structured.ts`
- `supabase/functions/_shared/hybrid_query_utils.ts`
- `supabase/functions/_shared/hybrid_search_handler.ts`
- `supabase/functions/_shared/foundation_dataset_extraction.ts`
- `supabase/functions/_shared/dataset_extraction_worker.ts`
- `supabase/functions/_shared/embedding_ft_job.ts`
- `supabase/functions/_shared/embedding_ft_postgres.ts`
- `supabase/functions/_shared/embedding_vector.ts`

All seven Hybrid endpoints are thin route configurations over one shared handler. It owns runtime authentication, deterministic query-rewrite prompts, 1024-dimensional SageMaker validation, JWT preservation for `my`/`te`, RPC fallback, response shape, and redacted structured logs. Each route calls its database `hybrid_search_*_v2` RPC and forwards one `lexical_weight` plus `semantic_weight`; no second lexical request control exists. Only the four foundation routes forward the reviewed optional `state_code_filter` and `team_id_filter` fields. Team authorization remains database-owned. The four foundation datasets use deterministic English-heading Markdown extractors and the compact database-owned extraction queue; missing id/version pairs are acknowledged as stale no-ops, while invalid entity/table combinations are terminal failures. The `embedding_ft` worker accepts canonical PostgreSQL UUID text, including imported dataset identities whose version or variant bits are not RFC-classified, because the database owns those identifiers. It still accepts only the seven reviewed public table, content-function, and `embedding_ft` column targets (including the guarded Flow/Process derivative input variants); request-provided SQL identifiers are never an open dynamic target surface.

Each `embedding_ft` Edge isolate processes one request batch sequentially, so its Postgres.js client is intentionally capped at one connection, closes after 20 idle seconds, and has a 300-second maximum lifetime. The `embedding-ft-edge` application name makes aggregate connection evidence auditable without exposing row identities. A wider default pool or an unbounded idle lifetime can multiply retained connections across isolates and must not be used to accelerate database-owned queue backfill.

The three legacy OpenAI summary webhooks and the generic non-FT embedding worker are retired from the source inventory. The deterministic `webhook_*_embedding_ft` and `embedding_ft` routes remain active and covered by the default validation baseline.

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

The named `public_plus_owner_draft` calculation scope is a distinct versioned snapshot family. Edge freezes the authenticated actor and exact public-state-100 plus owner-state-0 predicate in a manifest and SHA-256; the owner-draft branch additionally requires null `team_id` and `review_id` on process/flow rows so team/reviewer visibility cannot leak into account-local calculation. That scope manifest applies only to processes and flows. LCIA method/factor truth is bound separately to the reviewed frontend static-cache manifest: Edge embeds the exact manifest bytes, raw SHA-256, path, and release hashes, but never accepts a client URL, path, or hash; the worker resolves the base URL from trusted configuration. Worker execution must independently enforce request/snapshot v2 and return exact `lca.calculation_evidence.v2` with all four source hashes and a non-empty 25-row `exchange_method_pair` coverage matrix. Every method identity and artifact locator must match the reviewed manifest, every row must have the same pair cardinality, aggregate counts must equal the row sums, and v2 gap-artifact record counts must equal all unmatched, invalid, and unsupported-direction pairs. Solve, query, and contribution-path routes reject v1 database/union evidence, the superseded combined-scope hash, missing evidence, and any source, identity, cardinality, count, status, or artifact drift before returning numeric values. Missing characterization factors are never represented as complete zero impact; raw private-storage gap URLs remain immutable evidence locators rather than browser download links.

`lca_query_results` keeps historical `all-unit-query:v1` matrix reads and consumes `all-unit-query:v2` as a bounded index over Calculation Bundle LCIA chunks. The v2 path verifies the persisted query-index size and SHA-256, keeps child paths inside the referenced bundle, and validates each downloaded gzip chunk's size, SHA-256, process range, record count, method identity, ordering, and finite values before returning a row or hotspot projection. It loads only the covering chunks for selected queries and processes full-hotspot chunks sequentially instead of rebuilding the removed full H matrix.

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

Calculation Bundle reads follow the same projection rule. The database returns only the manager-authorized immutable bundle ref. Edge downloads the private manifest, verifies its exact size and SHA-256 plus schema/content-hash/artifact-count binding, rejects unsafe child paths, and returns short-lived signed URLs for the manifest and each LCI/LCIA chunk. Raw worker object URLs are never browser download contracts.

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

This repository has a versioned local `pre-push` hook under `.githooks/pre-push` that delegates to `scripts/docpact-gate.sh` and then runs non-mutating `npm run lint` plus `npm run check`. The hook aborts if the lint step changes the working tree, so generated formatting changes must be reviewed and committed before push. The gate resolves the CLI through `scripts/docpact`, so local agent shells do not need bare `docpact` on `PATH`. The hook is the local guard for docpact config validation, enforced doc-governance linting, and Edge Function checks; the GitHub `CI` workflow is manual-dispatch only.
