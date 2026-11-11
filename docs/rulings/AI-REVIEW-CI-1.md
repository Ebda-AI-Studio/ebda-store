# AI-REVIEW-CI-1: risky PRs are reviewed in CI and fail closed

Ruling AI-REVIEW-CI-1 - `.github/workflows/ai-review.yml` reviews every PR except an all-safe one (markdown, `docs/`, NEWLY ADDED test files; a modified or deleted existing test is reviewed because several safety guards here are test files; `.github/ai-review/risky-paths.mjs`, fail closed, foundation AIR-2) with `claude -p`, posts the findings, and applies `ai-review-passed` only when there are no criticals. A risky PR with no `CLAUDE_CODE_OAUTH_TOKEN` or any review infra error is blocked (foundation Ruling AIR-1). The gate runs from the base branch (`pull_request_target`, scripts checked out from the base, PR fetched as data only) and a diff of 400 KB or more fails (foundation AIR-4). The drain holds a `risky-path` PR until it carries `ai-review-passed`.

Secret: `CLAUDE_CODE_OAUTH_TOKEN` (`claude setup-token`, then `gh secret set CLAUDE_CODE_OAUTH_TOKEN -R Ebda-AI-Studio/ebda-store`). The scripts under `.github/ai-review/` are copies of foundation `ci/ai-review/`; the workflow `jobs:` match foundation's `.github/workflows/ai-review.yml` (Ruling AIR-3).

Cost if wrong: while the secret is missing, every risky PR is red by design.

Fork PRs are never skipped and never reviewed with secrets: the check is red until a maintainer adds the label `ai-review-passed` (foundation AIR-5).
