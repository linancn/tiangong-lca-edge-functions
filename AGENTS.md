---
title: edge-functions AI Working Guide
docType: contract
scope: repo
status: active
authoritative: true
owner: edge-functions
language: en
whenToUse:
  - when a task may change Edge Function runtime behavior, auth handling, request or response semantics, deploy scripts, or repo validation flow
  - when routing work from the workspace root into tiangong-lca-edge-functions
  - when deciding whether a change belongs here, in database-engine, in tiangong-lca-next, or in lca-workspace
whenToUpdate:
  - when repo ownership or source-of-truth boundaries change
  - when branch, deploy, auth-probe, or validation contracts change
  - when the repo-local AI bootstrap docs under ai/ change
checkPaths:
  - AGENTS.md
  - README.md
  - ai/**/*.md
  - ai/**/*.yaml
  - package.json
  - supabase/config.toml
  - supabase/functions/**
  - test/**
  - scripts/**
  - test.example.http
  - supabase/.env.example
  - .github/workflows/**
  - .github/PULL_REQUEST_TEMPLATE/**
lastReviewedAt: 2026-04-18
lastReviewedCommit: 94889a43af4e63a496bcbbb2e2bf5f3a69677dc0
related:
  - ai/repo.yaml
  - ai/task-router.md
  - ai/validation.md
  - ai/architecture.md
  - README.md
  - test.example.http
---

# AGENTS.md — edge-functions AI Working Guide

`tiangong-lca-edge-functions` owns the checked-in Supabase Edge Function runtime contract for TianGong LCA. Start here when the task may change function behavior, shared runtime modules, deploy scripts, or repo-local validation expectations.

## AI Load Order

Load docs in this order:

1. `AGENTS.md`
2. `ai/repo.yaml`
3. `ai/task-router.md`
4. `ai/validation.md`
5. `ai/architecture.md`
6. `README.md` and `test.example.http` only when you need human setup details or concrete request examples

Do not start with the long README, raw function inventories, or GitHub default-branch UI.

## Repo Ownership

This repo owns:

- `supabase/functions/**` for Edge Function entrypoints, handlers, and runtime request or response behavior
- `supabase/functions/_shared/**` for auth, command runtime, DB-RPC wrappers, OpenAI, Redis, Supabase client helpers, and shared domain utilities
- `test/**` for repo-level Deno tests
- `scripts/deno-check-all.cjs`, `scripts/deploy-function.cjs`, `scripts/probe-functions-auth.cjs`, and `scripts/lca_submit_poll_fetch.sh`
- `package.json` for Node scripts, Supabase CLI pinning, and remote project-ref mapping
- `supabase/config.toml` for local serve and edge deploy bindings
- `.github/workflows/ci.yml` and `.github/PULL_REQUEST_TEMPLATE/**`
- `test.example.http` and `supabase/.env.example` as checked-in request and env examples

This repo does not own:

- database schema, migrations, persistent Supabase branch governance, or SQL regression-test truth
- frontend page behavior, app-side workflow behavior, or frontend env selection
- workspace submodule pointer bumps or delivery completion

Route those tasks to:

- `tiangong-lca/database-engine` for schema truth, migrations, SQL tests, and Supabase branch governance
- `linancn/tiangong-lca-next` for frontend behavior and app-side flows
- `tiangong-lca/workspace` for root integration after merge

## Branch Facts

- GitHub default branch: `main`
- True daily trunk: `dev`
- Routine branch base: `dev`
- Routine PR base: `dev`
- Promote path: `dev -> main`
- Hotfix path: branch from `main`, merge back into `main`, then back-merge `main -> dev`

Do not accept GitHub UI defaults when opening routine PRs.

## Runtime Facts

- Repo-local AI-doc maintenance is enforced by `.github/workflows/ai-doc-lint.yml` using the vendored `.github/scripts/ai-doc-lint.*` files.
- Local serve command: `npm start`
- Baseline local validation: `npm run lint`, `npm run check`
- `npm run check` walks enabled `supabase/functions/*/index.ts` files plus `test/*.ts`
- Baseline `npm run check` intentionally skips `antchain_*`, `embedding`, `webhook_flow_embedding`, `webhook_model_embedding`, and `webhook_process_embedding`
- Remote deploy entrypoints:
  - `npm run deploy:dev -- <function-name> [more-function-names...]`
  - `npm run deploy:main -- <function-name> [more-function-names...]`
- Both deploy scripts append `--no-verify-jwt`
- Local serve also uses `--no-verify-jwt`
- Gateway JWT verification being off does not mean runtime auth is optional; functions must still authenticate and authorize requests
- Auth and connectivity drift triage starts with `npm run probe:auth -- --remote` or `npm run probe:auth -- --local`

## Quick Routes

| If the task is about... | Load next |
| --- | --- |
| adding or changing one Edge Function or shared runtime module | `ai/task-router.md`, then `ai/validation.md` |
| changing auth, credential precedence, or command-runtime behavior | `ai/task-router.md`, then `ai/architecture.md` |
| changing deploy targets, project refs, or auth-probe behavior | `ai/repo.yaml`, then `ai/validation.md` |
| changing request examples, smoke-test workflow, or repo-level tests | `ai/validation.md`, then `README.md` or `test.example.http` |
| deciding whether missing SQL or RPC behavior belongs here | `ai/task-router.md`, then root `ai/task-router.md` and `database-engine/AGENTS.md` |
| deciding whether a merged repo PR is delivery-complete | root `AGENTS.md` and `_docs/workspace-branch-policy-contract.md` in `lca-workspace` |

## Hard Boundaries

- Do not invent schema truth or migration history in this repo.
- Do not interpret `--no-verify-jwt` as permission for anonymous business logic.
- Do not move repo-level tests into `supabase/functions/**`; current convention keeps them in `test/**`.
- Do not treat GitHub default branch `main` as the daily trunk.
- Do not mark delivery complete if root workspace integration is still pending.

## Workspace Integration

A merged PR in `tiangong-lca-edge-functions` is repo-complete, not delivery-complete.

If the change must ship through the workspace:

1. merge the child PR into `tiangong-lca-edge-functions`
2. make sure the intended SHA is eligible for root integration
3. update the `lca-workspace` submodule pointer deliberately

For normal root `main` integration, `lca-workspace/main` should point only at commits already promoted onto `tiangong-lca-edge-functions/main`.
