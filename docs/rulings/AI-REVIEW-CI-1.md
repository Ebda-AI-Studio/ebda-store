# AI-REVIEW-CI-1: risky PRs are reviewed in CI and fail closed

Ruling AI-REVIEW-CI-1 - `.github/workflows/ai-review.yml` reviews every PR except an all-safe one (markdown, `docs/`, NEWLY ADDED test files; a modified or deleted existing test is reviewed because several safety guards here are test files; `.github/ai-review/risky-paths.mjs`, fail closed, foundation AIR-2) with `claude -p`, posts the findings, and applies `ai-review-passed` only when there are no criticals. A risky PR with no `CLAUDE_CODE_OAUTH_TOKEN` or any review infra error is blocked (foundation Ruling AIR-1). The gate runs from the base branch (`pull_request_target`, scripts checked out from the base, PR fetched as data only) and a diff of 400 KB or more fails (foundation AIR-4). The drain holds a `risky-path` PR until it carries `ai-review-passed`.

Secret: `CLAUDE_CODE_OAUTH_TOKEN` (`claude setup-token`, then `gh secret set CLAUDE_CODE_OAUTH_TOKEN -R Ebda-AI-Studio/ebda-store`). The scripts under `.github/ai-review/` are copies of foundation `ci/ai-review/`; the workflow `jobs:` match foundation's `.github/workflows/ai-review.yml` (Ruling AIR-3).

Cost if wrong: while the secret is missing, every risky PR is red by design.

Fork PRs are never skipped and never reviewed with secrets: the check is red until a maintainer adds the label `ai-review-passed` (foundation AIR-5).

## AI-REVIEW-LABEL-1 (2026-11-15)

Ruling AI-REVIEW-LABEL-1 - the AI review workflow removes `ai-review-passed` only on a real review verdict with critical findings (`review.mjs` writes `verdict=critical`). The classify step no longer removes it, and the 400 KB refusal, a crashed or timed-out model call and any other infra failure leave every label untouched. Evidence: PR #803 lost the controller's label 3x on 2026-11-15 and the merge drain held it. Staleness against a new head is the drain's check (label set after the head), not this workflow's. Cost if wrong: a stale label from an older head survives until the drain's set-after-head check rejects it.
