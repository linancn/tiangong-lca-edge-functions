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
lastReviewedAt: 2026-06-02
lastReviewedCommit: 07d218208e049d3d23e8091102e5a97b7c4dfc51
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
- `embedding`
- `webhook_flow_embedding`
- `webhook_model_embedding`
- `webhook_process_embedding`

If you reactivate or rely on one of those routes, update the inventory and validation story in the same change.

## Validation Matrix

| Change type | Minimum local proof | Additional proof when risk is higher | Notes |
| --- | --- | --- | --- |
| One function entrypoint or nearby handler | `npm run lint`; `npm run check`; targeted `deno check --config supabase/functions/deno.json <changed-entry-or-handler>` | use `test.example.http` or an equivalent request to smoke the changed path | For handler-based functions, validate both the entrypoint and the extracted handler file. |
| Shared auth modules | `npm run lint`; `npm run check`; targeted `deno check` on `_shared/auth.ts` and directly affected consumers | run `npm run probe:auth -- --dry-run`; run a local or remote probe if the change affects credential selection | `gateway_invalid_jwt` and `function_auth_failed` are different failure classes. |
| Command runtime, command handlers, or DB-RPC wrappers | `npm run lint`; `npm run check`; targeted `deno check` on changed `_shared/command_runtime/**`, `_shared/commands/**`, `_shared/db_rpc/**`, and at least one direct consumer | run nearby repo tests such as `test/command_runtime_test.ts`, `test/dataset_command_rpc_contract_test.ts`, or `test/review_command_rpc_contract_test.ts` | If the change depends on new SQL or RPC truth, record the `database-engine` follow-up explicitly. |
| Review-submit numerical gate API, submit job worker, worker job API/wrapper, or submit-review gate assertion | `npm run lint`; `npm run check`; targeted `deno check` on `app_dataset_review_submit_gate`, `app_dataset_review_submit_jobs`, `app_worker_jobs`, `process_dataset_review_submit_jobs`, dataset command files, worker command files, worker files, and DB-RPC wrappers; run `test/app_dataset_review_submit_gate_test.ts`, `test/app_dataset_review_submit_jobs_test.ts`, `test/app_worker_jobs_test.ts`, `test/review_submit_job_worker_test.ts`, `test/worker_jobs_test.ts`, `test/app_dataset_submit_review_test.ts`, and `test/dataset_command_rpc_contract_test.ts` | smoke `app_dataset_review_submit_gate`, `app_dataset_review_submit_jobs`, `app_worker_jobs`, and the service worker against a dev environment only after the database-engine gate/job RPCs exist | Keep edge response semantics aligned with worker-produced `review_submit_gate_report.v1` and database-engine persisted assertion truth; derive the authoritative checksum from persisted `json_ordered`, treat client checksums as diagnostics only, and do not duplicate worker blocker heuristics in Edge. |
| Hybrid search, AI suggestion, or OpenAI shared layer | `npm run lint`; `npm run check`; targeted `deno check` on changed function and shared OpenAI helper files | smoke one relevant request from `test.example.http` or equivalent local or remote call | Model defaults and query-rewrite helpers live in repo code, not only in env or README prose. |
| LCA solve, queue, result, or scope helpers | `npm run lint`; `npm run check`; targeted `deno check` on changed `lca_*` files and `_shared/lca_*` helpers; for worker_jobs cutover changes also run `test/worker_jobs_cutover_test.ts`, `test/worker_jobs_test.ts`, and `test/lca_snapshot_scope_test.ts` | run `scripts/lca_submit_poll_fetch.sh` when the task explicitly touches the submit, poll, or fetch path; otherwise record why that proof is deferred | `worker_jobs` is the default enqueue path; `LCA_WORKER_JOBS_ENABLED=false` must fail closed instead of using legacy queue fallback. Domain rows/cache remain result metadata, not task fact. Missing worker_jobs DB-side truth is validated in `database-engine`, not here. |
| TIDAS package import, export, or job paths | `npm run lint`; `npm run check`; targeted `deno check` on changed package files and `_shared/tidas_package.ts`; run `deno test --allow-env --config supabase/functions/deno.json test/tidas_package_test.ts test/tidas_package_api_test.ts` when package enqueue behavior changes | use the relevant requests in `test.example.http`; if auth or payload shaping changed, run a local or remote smoke path | JWT and `USER_API_KEY` coverage matters for these routes. `worker_jobs` is the default enqueue path; `TIDAS_PACKAGE_WORKER_JOBS_ENABLED=false` must fail closed instead of using legacy queue fallback. Package domain rows/cache/artifacts stay retained metadata, not task fact. |
| Deploy script, `package.json`, `supabase/config.toml`, or PR contract files | `npm run lint`; inspect branch, project-ref, and deploy-flag changes against `AGENTS.md` and `.docpact/config.yaml`; run `npm run check` if runtime inventory or imports changed | if the task includes a real deploy, record which environment was deployed and which function names were used | Remote deploy proof is not implied by local lint or type-check. |
| Auth probe tooling | `npm run lint`; `node scripts/probe-functions-auth.cjs --help`; `npm run probe:auth -- --dry-run` | run `npm run probe:auth -- --remote` or `--local` when the task explicitly includes live probe validation | Dry-run is the safe default when you only changed classification or selection logic. |
| Repo tests only | `npm run lint`; `npm run check`; targeted `deno check --config supabase/functions/deno.json <changed-test-file>` | run neighboring tests that cover the same shared module or function family | This repo keeps Deno tests in `test/**`, not under each function folder. |
| Repo docs or docpact config only | `scripts/docpact validate-config --root . --strict`; `scripts/docpact lint --root . --worktree --mode enforce` | perform scenario-based route checks for the affected intent surface | Refresh review metadata when governed docs change without code changes. |

## Auth And Probe Notes

Facts that matter:

- local serve uses `--no-verify-jwt`
- scripted remote deploys also use `--no-verify-jwt`
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
