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
lastReviewedAt: 2026-08-01
lastReviewedCommit: 5956e5cc47b1086bb969f61643abc1a03b5f2d5d
lastReviewedNote: 'Updated for Issue #249 final review: the self-enforcing hosted proof distinguishes manual Preview content attestation from Git-bound deployment provenance and verifies cleanup plus the full residue ACL matrix.'
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
npm run lint
npm run check
```

`npm run check` runs `scripts/deno-check-all.cjs`, which walks enabled `supabase/functions/*/index.ts` files plus `test/*.ts`.

The current baseline intentionally skips:

- `antchain_*`

If you reactivate or rely on that route family, update the inventory and validation story in the same change. The retired generic non-FT embedding route is intentionally absent, while active `embedding_ft` routes stay covered.

## Validation Matrix

| Change type | Minimum local proof | Additional proof when risk is higher | Notes |
| --- | --- | --- | --- |
| One function entrypoint or nearby handler | `npm run lint`; `npm run check`; targeted `deno check --config supabase/functions/deno.json <changed-entry-or-handler>` | use `test.example.http` or an equivalent request to smoke the changed path | For handler-based functions, validate both the entrypoint and the extracted handler file. |
| Shared auth modules | `npm run lint`; `npm run check`; targeted `deno check` on `_shared/auth.ts` and directly affected consumers | run `npm run probe:auth -- --dry-run`; run a local or remote probe if the change affects credential selection | `gateway_invalid_jwt` and `function_auth_failed` are different failure classes. |
| Command runtime, command handlers, or DB-RPC wrappers | `npm run lint`; `npm run check`; targeted `deno check` on changed `_shared/command_runtime/**`, `_shared/commands/**`, `_shared/db_rpc/**`, and at least one direct consumer | run nearby repo tests such as `test/command_runtime_test.ts`, `test/dataset_command_rpc_contract_test.ts`, or `test/review_command_rpc_contract_test.ts` | If the change depends on new SQL or RPC truth, record the `database-engine` follow-up explicitly. |
| Data Product closure commands, certificate-bound result builds, TaskSummaryV2 feed, or closure-artifact signing | `npm run lint`; `npm run check`; `deno test --allow-env --config supabase/functions/deno.json test/data_product_command_test.ts`; `deno test --allow-env --allow-net=127.0.0.1 --config supabase/functions/deno.json test/data_product_command_http_smoke_test.ts`; targeted `deno check` on `app_data_product_commands`, `_shared/commands/data_product/**`, and `_shared/db_rpc/data_product_commands.ts` | against a local database-engine stack, prove owner/manager and cross-user denial, a v2 build does not double-enqueue its persisted job, feed rows expose no payload/locator/signed URL, closure-check reads expose exactly two locator-free availability summaries, and only the requested XLSX or machine-result manifest is signed from a ready unexpired actor-bound descriptor; also prove strict selector forwarding, semantic filenames, the artifact-expiry safety budget, delayed-signing boundary, stable owner-visible `410`, opaque unavailable/unauthorized `404`, sanitized unexpected-RPC/signing `502`, and recursive locator/credential rejection | Database owns scope normalization, Certificate validity, feed ACL, artifact lifecycle, and artifact authorization. Edge must keep request/descriptor schemas strict, expose only the reviewed public projection, call the two-argument RPC, and keep bucket/object paths and all source error details inside the service-only signing step. The local HTTP smoke must traverse the function handler plus real Supabase SDK PostgREST/Storage transports; unit-only `FakeRpc` proof is insufficient for this boundary. Partition selectors are outside this public endpoint. |
| Scope-closure Edge provider qualification adapter | `deno test --allow-env --config supabase/functions/deno.json test/scope_closure_edge_qualification_test.ts`; targeted `deno check` on `scripts/scope_closure_edge_qualification.ts`; execute `scripts/run_scope_closure_edge_qualification.sh` twice from a clean exact commit with the same `--run-id` and compare outputs; validate one result with the exact Worker provider-owner aggregator contract | feed the git-tracked adapter to Worker `scripts/run_scope_closure_provider_qualification.sh` with the other owner adapters and isolated Linux provider dependencies when the full provider run is coordinated | The adapter accepts only explicit loopback/non-production qualification configuration, binds `componentSha` to a clean exact checkout, drives the real Edge handler and Supabase SDK against a generated loopback fixture, proves owner/cross-owner/ready/expiry/retry/HEAD/range/direct-object behavior for XLSX and manifest roles, and emits only deterministic locator-free `lcia.scope-closure-provider-owned-result.v1` evidence with `productionMutation=false`. |
| LCI/LCIA release commands, artifact verification, or public release reads | `npm run lint`; `npm run check`; `deno test --allow-env --config supabase/functions/deno.json test/lca_release_command_test.ts test/lca_release_results_test.ts`; targeted `deno check` on both release entrypoints | against a local database-engine stack, exercise prepare → upload → finalize → approve → publish → signed readback with a `data_product_manager`, then repeat a mutation and private read with a non-manager | Prove all four profile/format pairs, canonical content-addressed object paths, retryable signed-upload upsert at only the same immutable identity, exact byte/hash checks, actor-role recheck before service finalize, public access both without Authorization and with the matching project publishable/legacy anon Bearer credential, private denial, Calculation Bundle manifest binding/path safety and chunk signing, server-derived semantic download filenames, and failure before any service mutation. Live deployment is separate proof. |
| Review-submit numerical gate API, submit job worker, Worker capability repository/API, or submit-review gate assertion | `npm run lint`; `npm run check`; `npm run test:worker-contract:unit`; `npm run test:worker-contract:consumer-zero`; targeted `deno check` on `app_dataset_review_submit_gate`, `app_dataset_review_submit_jobs`, `app_worker_jobs`, `process_dataset_review_submit_jobs`, dataset command files, Worker capability/command files, and compatibility DB-RPC exports; run `test/app_dataset_review_submit_gate_test.ts`, `test/app_dataset_review_submit_jobs_test.ts`, `test/app_worker_jobs_test.ts`, `test/review_submit_job_worker_test.ts`, `test/worker_jobs_test.ts`, `test/app_dataset_submit_review_test.ts`, and `test/dataset_command_rpc_contract_test.ts` | with the matching database-engine worker migration applied to an isolated loopback stack, set `WORKER_CAPABILITY_DB_URL` and the local Supabase URL/publishable/service keys, then run `npm run test:worker-contract:db`; for the approved isolated hosted Preview, set `WORKER_CAPABILITY_SUPABASE_ACCESS_TOKEN` and the Preview URL/publishable/service keys, then run `npm run test:worker-contract:hosted`; the wrapper fixes enable/mode and requires exactly one executed test with zero ignored/failures; never target production | The hosted contract does not trust caller-supplied expected provenance. The current disposable Preview is explicitly attested as manual and non-Git-bound: branch `git_branch`, PR, and latest-check fields are null; branch workflow status is `MIGRATIONS_FAILED`, its action migrate step is `DEAD`, and the independent Preview project is `ACTIVE_HEALTHY` with no copied data. Therefore the proof claims exact hosted contract-content parity, not a Git deployment SHA. Supabase migration API/ledger/statement receipt and the migration-generated postgres-owned residue view bind the hosted catalog; the residue proof checks its exact definition/relacl plus SELECT/INSERT/UPDATE/DELETE for service, anon, authenticated, and internal-executor roles. GitHub independently verifies merged database-engine PR `#365`, commit `6809528c32bac8163e9a6eec9b985d57370589e1`, migration SHA, and the checked-in qualification receipt plus its base/migration/rollback/source bindings. The matrix proves all six `api.worker_*_v1` service positives and exact `42501` for anon/foreign/owner/admin across all six RPCs and `api.worker_job_domain_refs`. Cleanup always attempts every controlled job/user, aggregates failures with any primary failure, then uses read-only SQL to prove every job is cancelled and every temporary user is absent. The consumer-zero proof covers single-, double-, and backtick-quoted legacy literals and rejects versioned direct calls outside the capability repository. A Git-bound deployment SHA remains a later persistent-dev merge-SHA readback gate. Snapshot lookup must preserve the bounded `created_at DESC, id DESC` candidate scan and Edge-side expiry loop. |
| Hybrid search, foundation-dataset extraction, `embedding_ft`, AI suggestion, or OpenAI shared layer | `npm run lint`; `npm run check`; targeted `deno check` on changed entrypoints and shared helpers; run `test/dataset_extraction_worker_test.ts`, `test/foundation_dataset_extraction_test.ts`, `test/embedding_ft_job_test.ts`, `test/embedding_ft_postgres_test.ts`, `test/embedding_vector_test.ts`, `test/hybrid_search_handler_test.ts`, `test/hybrid_query_utils_test.ts`, `test/hybrid_search_request_test.ts`, and `test/hybrid_search_rpc_context_test.ts` when the shared foundation search path changes | on the exact non-production deployment whose database contains the matching v2 RPCs, drain a bounded extraction/embedding batch and smoke all seven routes; cover Contact, FlowProperty, Source, and UnitGroup requests for `tg` plus JWT-backed `my`/`te`; prove state/team context reaches both the initial RPC and threshold fallback, while Process, Flow, and LifecycleModel receive no visibility-only fields; confirm stale extraction identities ACK without writes and invalid table/function/column jobs fail closed; for Postgres client lifecycle changes, aggregate `pg_stat_activity` by the redacted application name, prove connections return after the idle window, and prove Edge response bodies plus queue tables retain zero new connection-slot or terminal failures | Every Hybrid payload must contain one `lexical_weight` and one `semantic_weight`; no second lexical control is allowed. Model defaults and entity-specific query-rewrite prompts live in repo code. Foundation Markdown is deterministic; generated vectors must be exactly 1024-dimensional. Embedding job IDs must use canonical PostgreSQL UUID text but need not carry RFC-classified version/variant bits; malformed text still fails before target evaluation. The embedding worker remains restricted to the seven reviewed public dataset targets; structured logs must not retain raw user query text. Each isolate processes its batch sequentially and therefore owns one short-idle, bounded-lifetime Postgres connection; do not widen that pool or raise database queue concurrency to hide connection pressure. Edge validates only field shape and forwards the user JWT; database backfill, team authorization, queue truth, RPC visibility, and HNSW plan proof remain in `database-engine`. |
| LCA solve, queue, result, or scope helpers | `npm run lint`; `npm run check`; targeted `deno check` on changed `lca_*` files and `_shared/lca_*` helpers; run neighboring scope/queue tests. Static LCIA contract changes must run `test/lca_static_cache_bundle_contract_test.ts`, `test/lca_snapshot_scope_test.ts`, `test/lca_snapshot_scope_db_test.ts`, `test/lca_snapshot_build_queue_test.ts`, and `test/lca_all_unit_solve_queue_test.ts` with `--allow-read` so raw-manifest hash parity and adversarial locator/evidence drift are covered. For worker_jobs cutover changes also run `test/worker_jobs_cutover_test.ts` and `test/worker_jobs_test.ts` | run `scripts/lca_submit_poll_fetch.sh` when the task explicitly touches the submit, poll, or fetch path; otherwise record why that proof is deferred | `worker_jobs` is the default enqueue path; `LCA_WORKER_JOBS_ENABLED=false` must fail closed instead of using legacy queue fallback. Named private scope rejects old combined-scope hashes and v1 database/union LCIA evidence. The static source base URL is worker-trusted configuration, never a client field. Domain rows/cache remain result metadata, not task fact. Missing worker_jobs DB-side truth is validated in `database-engine`, not here. |
| TIDAS package import, export, or job paths | `npm run lint`; `npm run check`; targeted `deno check` on changed package files and `_shared/tidas_package.ts`; run `deno test --allow-env --config supabase/functions/deno.json test/tidas_package_test.ts test/tidas_package_api_test.ts` when package enqueue behavior changes | use the relevant requests in `test.example.http`; if auth or payload shaping changed, run a local or remote smoke path | JWT and `USER_API_KEY` coverage matters for these routes. `worker_jobs` is the default enqueue path; `TIDAS_PACKAGE_WORKER_JOBS_ENABLED=false` must fail closed instead of using legacy queue fallback. Package domain rows/cache/artifacts stay retained metadata, not task fact. |
| Deploy script, `package.json`, `supabase/config.toml`, or PR contract files | `npm run lint`; inspect branch, project-ref, import-map, and deploy-flag changes against `AGENTS.md` and `.docpact/config.yaml`; run `npm run check` if runtime inventory or imports changed | if the task includes a real deploy, record which environment was deployed and which function names were used | Remote deploy proof is not implied by local lint or type-check. Scripted deploys should resolve imports through `supabase/functions/deno.json`. |
| Auth probe tooling | `npm run lint`; `node scripts/probe-functions-auth.cjs --help`; `npm run probe:auth -- --dry-run` | run `npm run probe:auth -- --remote` or `--local` when the task explicitly includes live probe validation | Dry-run is the safe default when you only changed classification or selection logic. |
| Repo tests only | `npm run lint`; `npm run check`; targeted `deno check --config supabase/functions/deno.json <changed-test-file>` | run neighboring tests that cover the same shared module or function family | This repo keeps Deno tests in `test/**`, not under each function folder. |
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
npm run probe:auth -- --dry-run
npm run probe:auth -- --remote --only lca_
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

The `pre-push` hook runs `scripts/docpact-gate.sh`, which delegates CLI lookup to `scripts/docpact` and performs strict config validation plus enforced lint before the push leaves the machine. It then runs non-mutating `npm run lint` and `npm run check` as the local test gate, and aborts if the lint step changes the working tree before `npm run check`. The wrapper checks `DOCPACT_BIN`, Cargo install locations, Homebrew install locations, and then `PATH`, so local agent shells should not fail only because bare `docpact` is unavailable. The default comparison base is `origin/dev` for routine branches and `origin/main` for promote or hotfix branches. Override it for unusual stacks with `DOCPACT_BASE_REF=<ref>` or `scripts/docpact-gate.sh --base <ref>`. The gate writes its detailed report to a temporary file so normal pushes do not create `.docpact/runs/` artifacts. The GitHub `CI` workflow is manual-dispatch only rather than an ordinary push-triggered test runner.
