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
lastReviewedAt: 2026-04-24
lastReviewedCommit: a88517ffa1247661918261f78dc8c063aca6d133
related:
  - ../../AGENTS.md
  - ../../.docpact/config.yaml
  - ./repo-validation.md
  - ../../README.md
---

# edge-functions Architecture Notes

## Repo Shape

This repo is organized around Edge Function families plus a shared runtime layer under `supabase/functions/_shared`.

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

### Search, embedding, and AI-backed routes

These routes cluster around:

- `flow_hybrid_search`
- `process_hybrid_search`
- `lifecyclemodel_hybrid_search`
- `ai_suggest`
- `embedding_ft`
- `webhook_*_embedding_ft`

Important shared helpers:

- `supabase/functions/_shared/openai_chat.ts`
- `supabase/functions/_shared/openai_structured.ts`
- `supabase/functions/_shared/hybrid_query_utils.ts`

Legacy non-`*_ft` embedding and webhook routes still exist in the tree, but the default deno-check baseline skips them.

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

### TIDAS package flows

This cluster includes:

- `import_tidas_package`
- `export_tidas_package`
- `tidas_package_jobs`

Shared behavior lives in:

- `supabase/functions/_shared/tidas_package.ts`
- `supabase/functions/_shared/redis_client.ts`

## Database Boundary

This repo consumes database truth but does not own it.

Typical signs the task also belongs in `database-engine`:

- a route depends on a missing RPC such as `lca_enqueue_job`
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
