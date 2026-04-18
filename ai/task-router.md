---
title: edge-functions Task Router
docType: router
scope: repo
status: active
authoritative: false
owner: edge-functions
language: en
whenToUse:
  - when you already know the task belongs in tiangong-lca-edge-functions but need the right next path or next doc
  - when deciding whether a change belongs in one function, a shared runtime module, deploy tooling, or another repo
  - when routing between edge runtime work, database-engine follow-up, and root workspace integration
whenToUpdate:
  - when new high-frequency task categories appear
  - when cross-repo ownership boundaries change
  - when validation or deploy routing becomes misleading
checkPaths:
  - AGENTS.md
  - ai/repo.yaml
  - ai/task-router.md
  - ai/validation.md
  - ai/architecture.md
  - package.json
  - supabase/config.toml
  - supabase/functions/**
  - test/**
  - scripts/**
  - test.example.http
  - .github/workflows/**
  - .github/PULL_REQUEST_TEMPLATE/**
lastReviewedAt: 2026-04-18
lastReviewedCommit: 94889a43af4e63a496bcbbb2e2bf5f3a69677dc0
related:
  - ../AGENTS.md
  - ./repo.yaml
  - ./validation.md
  - ./architecture.md
  - ../README.md
  - ../test.example.http
---

# edge-functions Task Router

## Repo Load Order

When working inside `tiangong-lca-edge-functions`, load docs in this order:

1. `AGENTS.md`
2. `ai/repo.yaml`
3. this file
4. `ai/validation.md` or `ai/architecture.md`
5. `README.md` or `test.example.http` only when you need setup or concrete request examples

## High-Frequency Task Routing

| Task intent | First code paths to inspect | Next docs to load | Notes |
| --- | --- | --- | --- |
| Add or change one Edge Function route | `supabase/functions/<name>/index.ts` and nearby `handler.ts` when present | `ai/validation.md`, `ai/architecture.md` | Keep auth, request parsing, and response semantics with the function entrypoint. |
| Change shared auth behavior or credential precedence | `supabase/functions/_shared/auth.ts`, `cognito_auth.ts`, `decode_api_key.ts`, then affected functions | `ai/validation.md`, `ai/architecture.md` | Gateway JWT verification is not the contract; function-runtime auth is. |
| Change command-style dataset, review, team, or admin endpoints | `supabase/functions/app_*`, `supabase/functions/admin_*`, `supabase/functions/_shared/command_runtime/**`, `supabase/functions/_shared/commands/**`, `supabase/functions/_shared/db_rpc/**` | `ai/architecture.md`, `ai/validation.md` | These flows usually change request parsing, actor context, audit payloads, and DB RPC wrappers together. |
| Change hybrid search, AI suggestion, or OpenAI-backed behavior | `supabase/functions/flow_hybrid_search/**`, `process_hybrid_search/**`, `lifecyclemodel_hybrid_search/**`, `ai_suggest/**`, `supabase/functions/_shared/openai_*.ts`, `hybrid_query_utils.ts` | `ai/validation.md`, `ai/architecture.md` | OpenAI model choice and query rewrite behavior live here, not in frontend docs. |
| Change embedding or webhook pipeline behavior | `supabase/functions/embedding*`, `supabase/functions/webhook_*embedding*`, `supabase/functions/_shared/redis_client.ts` | `ai/validation.md`, `ai/architecture.md` | Baseline `npm run check` intentionally skips legacy non-`*_ft` embedding and webhook entrypoints. |
| Change LCA solve, queue, result, or scope behavior | `supabase/functions/lca_*/**`, `supabase/functions/_shared/lca_process_scope.ts`, `lca_snapshot_scope.ts` | `ai/validation.md`, `ai/architecture.md` | Missing queue RPCs or published-state semantics may require `database-engine` follow-up. |
| Change TIDAS package import, export, or job behavior | `supabase/functions/import_tidas_package/**`, `export_tidas_package/**`, `tidas_package_jobs/**`, `supabase/functions/_shared/tidas_package.ts`, `redis_client.ts` | `ai/validation.md`, `ai/architecture.md` | JWT versus `USER_API_KEY` behavior is part of the runtime contract here. |
| Investigate deploy target, project ref, or `--no-verify-jwt` behavior | `package.json`, `scripts/deploy-function.cjs`, `supabase/config.toml`, `.github/PULL_REQUEST_TEMPLATE/**` | `ai/repo.yaml`, `ai/validation.md` | Do not change deploy targets or auth assumptions silently. |
| Investigate auth or connectivity drift across many functions | `scripts/probe-functions-auth.cjs`, `test.example.http`, then affected functions | `ai/validation.md` | Use `--dry-run`, `--remote`, or `--local` before editing many handlers. |
| Decide whether the task is actually a database schema or RPC-truth change | `database-engine`, not this repo | root `ai/task-router.md`, `database-engine/AGENTS.md` | Schema, migrations, SQL tests, and persistent branch governance do not belong here. |
| Decide whether work is delivery-complete after merge | root workspace docs, not repo code paths | root `AGENTS.md`, `_docs/workspace-branch-policy-contract.md` | Root integration remains a separate phase. |

## Wrong Turns To Avoid

### Fixing SQL truth in edge code only

If the bug is really missing migration or RPC truth, do not paper over it only in runtime code. Route the database side to `database-engine`.

### Assuming routine PRs should target `main`

`tiangong-lca-edge-functions` is an M2 repo:

- GitHub default branch: `main`
- true daily trunk: `dev`
- routine PR base: `dev`

### Treating `gateway_invalid_jwt` as a function-runtime result

`scripts/probe-functions-auth.cjs` distinguishes:

- `gateway_invalid_jwt`: rejected before the function likely ran
- `function_auth_failed`: request reached the runtime but the runtime auth path rejected it

Do not debug those as the same failure.

## Cross-Repo Handoffs

Use these handoffs when work crosses repo boundaries:

1. runtime change depends on new SQL or RPC behavior
   - start here for runtime code
   - then coordinate with `database-engine`
2. Edge API contract change impacts frontend flows
   - start here for runtime truth
   - then notify `tiangong-lca-next`
3. merged repo PR still needs to ship through the workspace
   - return to `lca-workspace`
   - do the submodule pointer bump there

## If You Still Need More Context

Load:

1. `ai/architecture.md` for repo shape and hotspot map
2. `ai/validation.md` for minimum proof
3. `README.md` and `test.example.http` only for human setup or request examples
