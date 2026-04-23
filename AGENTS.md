---
title: edge-functions Repo Contract
docType: contract
scope: repo
status: active
authoritative: true
owner: edge-functions
language: en
whenToUse:
  - when the task may change Edge Function runtime behavior, auth handling, request or response semantics, deploy scripts, or repo validation flow
  - when routing work from the workspace root into tiangong-lca-edge-functions
  - when deciding which document owns a rule, command, or runtime boundary
whenToUpdate:
  - when repo facts, branch rules, deploy/auth rules, or source-of-truth boundaries change
  - when the repo validation or repo-shape entry docs become inaccurate
  - when documentation ownership becomes redundant or ambiguous
checkPaths:
  - AGENTS.md
  - README.md
  - .docpact/**/*.yaml
  - docs/agents/**
  - package.json
  - supabase/config.toml
  - supabase/functions/**
  - test/**
  - scripts/**
  - test.example.http
  - supabase/.env.example
  - .github/workflows/**
  - .github/PULL_REQUEST_TEMPLATE/**
lastReviewedAt: 2026-04-23
lastReviewedCommit: 63e23a8cb916cb49521cbbe869b38d637040a8b5
related:
  - .docpact/config.yaml
  - docs/agents/repo-validation.md
  - docs/agents/repo-architecture.md
  - README.md
---

## Repo Contract

`tiangong-lca-edge-functions` owns the checked-in Supabase Edge Function runtime contract for TianGong LCA: function entrypoints, shared runtime helpers, repo-level validation tooling, deploy scripts, supporting request collections, and repo-local documentation governance.

Start here when the task may change Edge runtime behavior, auth/deploy semantics, repo proof expectations, or repo documentation ownership.

## Documentation Roles

| Document | Owns | Does not own |
| --- | --- | --- |
| `AGENTS.md` | repo contract, branch and delivery rules, hard boundaries, minimal execution facts | deep runtime path maps, full proof matrix, long setup prose |
| `.docpact/config.yaml` | machine-readable repo facts, routing intents, governed-doc rules, ownership, coverage, freshness | explanatory prose or narrative walkthroughs |
| `docs/agents/repo-validation.md` | minimum proof by change type, probe/deploy proof guidance, PR validation note shape | repo contract, branch policy truth, large setup notes |
| `docs/agents/repo-architecture.md` | compact repo mental model, stable path map, hotspot families, common misreads | checklists or current proof queue |
| `README.md` | human landing context, setup, local serve, operator-facing notes, and request-example guidance | machine-readable routing or lint semantics or the raw request-collection artifact |
| `.github/PULL_REQUEST_TEMPLATE/*.md` | branch-specific PR note shape and handoff prompts | canonical proof rules or repo ownership truth |

## Load Order

Read in this order:

1. `AGENTS.md`
2. `.docpact/config.yaml`
3. `docs/agents/repo-validation.md` or `docs/agents/repo-architecture.md`
4. `README.md` or `.github/PULL_REQUEST_TEMPLATE/*.md` only when the task needs setup or PR handoff details
5. `test.example.http` only when you need concrete local or remote request payloads after the contract surface has already routed the task

Do not start from repo landing prose or raw function inventories when the core contract surface is enough.

## Operational Pointers

- path-level ownership, routing intents, governed-doc inventory, and lint rules live in `.docpact/config.yaml`
- minimum proof and deploy/auth-probe expectations live in `docs/agents/repo-validation.md`
- stable path groups and hotspot families live in `docs/agents/repo-architecture.md`
- human setup and request-example guidance stay in `README.md`
- `test.example.http` is a supporting request collection for concrete payloads, not a governed source doc
- repo-local documentation maintenance is enforced by `.github/workflows/ai-doc-lint.yml` with `docpact lint`
- the main routing intents are `function-runtime`, `auth-runtime`, `command-runtime`, `search-and-embedding`, `lca-runtime`, `tidas-package`, `deploy-auth-drift`, `proof`, `repo-docs`, and `root-integration`

## Minimal Execution Facts

Keep these entry-level facts in `AGENTS.md`. Use `README.md` and `docs/agents/repo-validation.md` for the full setup and proof details.

- package manager: `npm`
- Node baseline: `22`
- local serve command: `npm start`
- baseline local validation: `npm run lint` and `npm run check`
- remote deploy entrypoints:
  - `npm run deploy:dev -- <function-name> [more-function-names...]`
  - `npm run deploy:main -- <function-name> [more-function-names...]`
- auth and connectivity drift probe: `npm run probe:auth -- --remote` or `npm run probe:auth -- --local`
- local serve and scripted remote deploys both use `--no-verify-jwt`
- gateway JWT verification being off does not make runtime auth optional; functions must still authenticate and authorize requests explicitly

## Ownership Boundaries

The authoritative path-level ownership map lives in `.docpact/config.yaml`.

At a human-readable level, this repo owns:

- `supabase/functions/**` for Edge Function entrypoints, handlers, and runtime request or response behavior
- `supabase/functions/_shared/**` for auth, command runtime, DB-RPC wrappers, OpenAI, Redis, Supabase client helpers, and shared domain utilities
- `test/**` for repo-level Deno tests
- `scripts/**` for deno-check inventory, deploy contract, auth probes, and smoke helpers
- `package.json`, `supabase/config.toml`, and `supabase/.env.example` for repo runtime/deploy/operator configuration
- `README.md`, supporting request collection `test.example.http`, `.github/PULL_REQUEST_TEMPLATE/**`, and repo-local governed docs

This repo does not own:

- database schema, migrations, persistent Supabase branch governance, or SQL regression-test truth
- frontend page behavior, app-side workflow behavior, or frontend env selection
- workspace submodule pointer bumps or delivery completion

Route those tasks to:

- `database-engine` for schema truth, migrations, SQL tests, RPC truth, and persistent branch governance
- `tiangong-lca-next` for frontend behavior and app-side flows
- `lca-workspace` for root integration after merge

## Branch And Delivery Facts

- GitHub default branch: `main`
- true daily trunk: `dev`
- routine branch base: `dev`
- routine PR base: `dev`
- promote path: `dev -> main`
- hotfix path: branch from `main`, merge into `main`, then back-merge `main -> dev`

Do not infer routine workflow from GitHub default-branch UI alone.

## Documentation Update Rules

- if a machine-readable repo fact, routing intent, or governed-doc rule changes, update `.docpact/config.yaml`
- if a human-readable repo contract, branch rule, or hard boundary changes, update `AGENTS.md`
- if proof expectations change, update `docs/agents/repo-validation.md`
- if repo shape, hotspot families, or path ownership explanation changes, update `docs/agents/repo-architecture.md`
- if setup steps or operator-facing guidance change, update `README.md`
- if checked-in request examples change, update `test.example.http`; update `README.md` too only when the human guidance or coverage summary changed
- if PR handoff prompts or M2 branch-note shape changes, update `.github/PULL_REQUEST_TEMPLATE/*.md`
- do not copy the same rule into multiple docs just to make it easier to find

## Hard Boundaries

- do not invent schema truth or migration history in this repo
- do not interpret `--no-verify-jwt` as permission for anonymous business logic
- do not move repo-level tests into `supabase/functions/**`; this repo keeps Deno tests in `test/**`
- do not treat GitHub default branch `main` as the daily trunk
- do not mark delivery complete if root workspace integration is still pending

## Workspace Integration

A merged PR in `tiangong-lca-edge-functions` is repo-complete, not delivery-complete.

If the change must ship through the workspace:

1. merge the child PR into `tiangong-lca-edge-functions`
2. promote or select an eligible child SHA according to workspace policy
3. update the `lca-workspace` submodule pointer deliberately
