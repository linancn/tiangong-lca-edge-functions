---
title: edge-functions Promote Dev To Main PR Template
docType: template
scope: repo
status: active
authoritative: false
owner: edge-functions
language: en
whenToUse:
  - when opening a promotion PR from dev into main
  - when checking the expected validation and follow-up note shape for a promote PR
whenToUpdate:
  - when promotion handoff expectations change
  - when validation or back-merge note shape for promote PRs changes
checkPaths:
  - .github/PULL_REQUEST_TEMPLATE/promote-dev-to-main.md
  - AGENTS.md
  - docs/agents/repo-validation.md
lastReviewedAt: 2026-04-23
lastReviewedCommit: 63e23a8cb916cb49521cbbe869b38d637040a8b5
---

## Promotion Contract

- Base branch: `main`
- Source branch: `dev`
- Validated environment before promotion: `dev` / `main` / `local serve`
- Remote deploy expected?: `No` / `Yes (main, explain)`
- Back-merge required after merge?: `No` / `Yes (main -> dev, explain)`
- Root workspace integration expected?: `No` / `Yes (explain)`

- [ ] This PR promotes `dev` into `main`.
- [ ] I confirm this repo's GitHub default branch remaining `main` is a platform exception; routine feature and fix work still lands in `dev` first.
- [ ] If remote deployment is part of this promotion, `main` deployment still uses the repo-standard `--no-verify-jwt` contract and the runtime auth boundary is documented.
- [ ] I verified the integrated result in `dev` before requesting promotion to `main`.
- [ ] If this PR includes a direct `main` hotfix path, I documented the required `main -> dev` back-merge plan.

## Linked Issue

Closes #

## Release Summary

<!-- What is being promoted, and which functions or shared modules are included? -->

## Validation

<!-- Evidence from dev validation, main-target checks, deploy evidence, or smoke tests. -->

## Integration / Follow-up

<!-- Root workspace submodule bump, release coordination, back-merge follow-up, or rollback notes. -->
