# CI-SHARD-1

> Section: 2026-11-11 CI fast, parallel, never flaky

Ruling CI-SHARD-1 - the affected unit suite (PR lane) and the full unit suite (main/nightly) run as 6 `vitest --shard=i/6` matrix jobs on GitHub-hosted runners, fail-fast off. Check names stay stable through roll-up jobs: `Unit Tests (affected)` (PR) and `Unit Tests` (main, which merges the shard blob reports and enforces the coverage threshold once). Workerd extras (status, accounts, prisma-lite DO, editor matrix) run on shard 1 only. Evidence: before, PR CI 20-29 min with 21 min in one job; main full lane about 50 min. Cost if wrong: six setups (npm ci, prisma, builds, chromium) per run multiply minutes by about 6 on the unit lane; N is one number in the matrix and in `--shard`.
