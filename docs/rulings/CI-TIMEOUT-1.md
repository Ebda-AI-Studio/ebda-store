# CI-TIMEOUT-1

> Section: Lifecycle emails and referral attribution (2026-10-22, branch `feat/lifecycle-emails`)

Ruling CI-TIMEOUT-1 - "Unit Tests (affected)" `timeout-minutes` 20 -> 35. Evidence: the #253 job started 00:26:21 and was cancelled at 00:46:39 (exactly 20 min); `vitest` only started at 00:42:57, so setup (npm ci, builds, chromium) consumed 16.5 minutes on a congested Umbra runner and the job was cancelled mid-tests, which the merge gate reads as a failure. #256's earlier "failure" was the same cancel. Cost if wrong: a genuinely hung unit job burns up to 35 minutes of runner time instead of 20.

---

> Section: Lifecycle emails and referral attribution (2026-10-22, branch `feat/lifecycle-emails`)

Ruling CI-TIMEOUT-1 - "Unit Tests (affected)" `timeout-minutes` 20 -> 35. Evidence: the #253 job started 00:26:21 and was cancelled at 00:46:39 (exactly 20 min); `vitest` only started at 00:42:57, so setup (npm ci, builds, chromium) consumed 16.5 minutes on a congested Umbra runner and the job was cancelled mid-tests, which the merge gate reads as a failure. #256's earlier "failure" was the same cancel. Cost if wrong: a genuinely hung unit job burns up to 35 minutes of runner time instead of 20.
