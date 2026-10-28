# CI-CONC-1

> Section: 2026-10-03 — Sentry backlog batch (branch `fix/followups13`, issues 2469–2473)

## Ruling CI-CONC-1 — main-push cancellation fixed for gitleaks only (issue 2454, 2026-10-03)

Decision: `gitleaks.yml` gives a push its own concurrency group keyed by sha (PR runs keep the per-ref group and stay cancellable), so the required secret scan cannot end `cancelled` on a main commit. Partial: `ci.yml`, `semgrep.yml` and `cf-deploy.yml` keep `cancel-in-progress: true` on their ref-keyed groups; `blast-radius.yml` is PR-only so it is not affected.
Evidence: the issue's run list shows `cancelled` gitleaks runs for main pushes `01d1d4210` and `4dddb4bc9`, and GitHub keeps one pending run per group, so `cancel-in-progress: false` could not prevent it. `tests/unit/gitleaks-concurrency.test.ts` pins the group and the cancel expression (mutation-checked). Not changed for the others because each needs its own decision: `cf-deploy.yml` diffs against the last SUCCESSFUL run, so letting runs queue instead of cancel changes what it deploys and when, and `ci.yml` main runs are post-merge only (the required checks run on the PR).
Cost if wrong: a burst of merges can still cancel a pending `ci.yml`/`semgrep.yml` main run, so the post-merge signal for that commit is missing, and a cancelled `cf-deploy.yml` run strands its apps until the next successful run (confirm a success covers the tip after merge bursts).
