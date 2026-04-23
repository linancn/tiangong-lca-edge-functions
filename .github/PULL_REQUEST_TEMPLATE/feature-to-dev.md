---
title: edge-functions Feature To Dev PR Template
docType: template
scope: repo
status: active
authoritative: false
owner: edge-functions
language: en
whenToUse:
  - when opening a routine feature or fix PR into dev
  - when checking the expected validation and handoff note shape for dev-bound work
whenToUpdate:
  - when branch handoff expectations for dev-bound PRs change
  - when the validation note shape for routine repo delivery changes
checkPaths:
  - .github/PULL_REQUEST_TEMPLATE/feature-to-dev.md
  - AGENTS.md
  - docs/agents/repo-validation.md
lastReviewedAt: 2026-04-23
lastReviewedCommit: 63e23a8cb916cb49521cbbe869b38d637040a8b5
---

## Branch Contract

- Base branch: `dev`
- Validated environment: `dev` / `main` / `local serve`
- Remote deploy expected?: `No` / `Yes (dev/main, explain)`
- Back-merge required after merge?: `No` / `Yes (explain)`
- Root workspace integration expected?: `No` / `Yes (explain)`

- [ ] This PR targets `dev`.
- [ ] I confirm this repo's GitHub default branch may still appear as `main`, but routine feature and fix PRs must target `dev`.
- [ ] If remote deployment is part of this change, I used the repo-standard `--no-verify-jwt` deploy contract and documented which environment was deployed.
- [ ] New or changed functions do not assume gateway-level JWT verification and still enforce runtime authentication / authorization.

## Linked Issue

Closes #

## Functions Changed

<!-- List the functions or shared modules changed in this PR. -->

## Validation

<!-- Commands run, local serve checks, Deno checks, deploy evidence, or request examples. -->

## Risks / Follow-up

<!-- Runtime auth notes, root integration notes, back-merge notes, or follow-up issues. -->
