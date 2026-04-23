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
lastReviewedAt: 2026-04-23
lastReviewedCommit: 63e23a8cb916cb49521cbbe869b38d637040a8b5
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
| Hybrid search, AI suggestion, or OpenAI shared layer | `npm run lint`; `npm run check`; targeted `deno check` on changed function and shared OpenAI helper files | smoke one relevant request from `test.example.http` or equivalent local or remote call | Model defaults and query-rewrite helpers live in repo code, not only in env or README prose. |
| LCA solve, queue, result, or scope helpers | `npm run lint`; `npm run check`; targeted `deno check` on changed `lca_*` files and `_shared/lca_*` helpers | run `scripts/lca_submit_poll_fetch.sh` when the task explicitly touches the submit, poll, or fetch path; otherwise record why that proof is deferred | Missing `lca_enqueue_job` or related DB-side truth is validated in `database-engine`, not here. |
| TIDAS package import, export, or job paths | `npm run lint`; `npm run check`; targeted `deno check` on changed package files and `_shared/tidas_package.ts` | use the relevant requests in `test.example.http`; if auth or payload shaping changed, run a local or remote smoke path | JWT and `USER_API_KEY` coverage matters for these routes. |
| Deploy script, `package.json`, `supabase/config.toml`, or PR contract files | `npm run lint`; inspect branch, project-ref, and deploy-flag changes against `AGENTS.md` and `.docpact/config.yaml`; run `npm run check` if runtime inventory or imports changed | if the task includes a real deploy, record which environment was deployed and which function names were used | Remote deploy proof is not implied by local lint or type-check. |
| Auth probe tooling | `npm run lint`; `node scripts/probe-functions-auth.cjs --help`; `npm run probe:auth -- --dry-run` | run `npm run probe:auth -- --remote` or `--local` when the task explicitly includes live probe validation | Dry-run is the safe default when you only changed classification or selection logic. |
| Repo tests only | `npm run lint`; `npm run check`; targeted `deno check --config supabase/functions/deno.json <changed-test-file>` | run neighboring tests that cover the same shared module or function family | This repo keeps Deno tests in `test/**`, not under each function folder. |
| Repo docs or docpact config only | `docpact validate-config --root . --strict`; `docpact lint --root . --worktree --mode enforce` | perform scenario-based route checks for the affected intent surface | Refresh review metadata when governed docs change without code changes. |

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
- `.github/workflows/ai-doc-lint.yml` should validate config and run `docpact lint`
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
