# AI-REVIEW-CI-1: risky PRs are reviewed in CI and fail closed

Ruling AI-REVIEW-CI-1 - `.github/workflows/ai-review.yml` reviews every PR that touches money/auth/data/migration paths (`.github/ai-review/risky-paths.mjs`) with `claude -p`, posts the findings, and applies `ai-review-passed` only when there are no criticals. A risky PR with no `CLAUDE_CODE_OAUTH_TOKEN` or any review infra error is blocked (foundation Ruling AIR-1). Non-risky PRs skip the review. The drain holds a `risky-path` PR until it carries `ai-review-passed`.

Secret: `CLAUDE_CODE_OAUTH_TOKEN` (`claude setup-token`, then `gh secret set CLAUDE_CODE_OAUTH_TOKEN -R Ebda-AI-Studio/ebda-store`). The scripts under `.github/ai-review/` are copies of foundation `ci/ai-review/`; the workflow `jobs:` match foundation's `.github/workflows/ai-review.yml` (Ruling AIR-3).

Cost if wrong: while the secret is missing, every risky PR is red by design.
