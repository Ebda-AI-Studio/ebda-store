# Handoff — FWB adversarial-audit remediation, PR 3 (record + gates)

_Updated 2026-09-02. Resume from here. Plan:
`docs/plans/2026-09-02-adversarial-audit-remediation.md`, Tasks 13-19._

## Correction (2026-09-02)

This file was 6 weeks stale, describing PRs #874/#881/#908/#920 as OPEN and
held behind a stuck CI runner (dated 2026-07-22). **All of that is done:**
the runner unstuck and every PR in that batch merged within 48h of the last
update — #879 (2026-07-22), #920 (2026-07-23), #908/#874/#881 (2026-07-24) —
and the trimmed item-5 WarehouseStock fix landed separately as #935
(2026-07-24). The whole 4-item OSOSS build program (agentic checkout,
answer-engine citation measurement + GSC ingestion, inventory drift fix) is
merged and live. Main is now at #1111 (verified `git log -1 main`, `gh pr
list --state open` returns zero), and CI runners are healthy (verified: 5 of
the last 5 workflow runs today `success`, the one `failure` is the known
lighthouse Chrome-install gap this same PR addresses). A NEXT session reading
the old version of this file would have resumed into a world 6 weeks gone —
this is the exact "6-week-stale handoff" finding from Task 18 of the plan
below, fixed on itself.

## Goal

Finish PR 3 of the 2026-09-02 adversarial-audit-remediation plan
(`docs/plans/2026-09-02-adversarial-audit-remediation.md`) — Tasks 13-19,
branch `fix/audit-record-and-gates`. This is the third of three PRs; PR 1
(P0 security) and PR 2 (P1 correctness) are separate worktrees/branches, not
this one — don't touch them from here.

## Current state

On `fix/audit-record-and-gates`, one commit per task so far (conventional-
commit style, `git log --oneline` on this branch shows the sequence).
Nothing pushed, no PR opened yet — per the plan's explicit instruction, stop
after the last commit.

## Done

- **Task 13** — corrected the dead `api-production-c058.up.railway.app`
  Railway host to `api.force-ai.co` across CLAUDE.md/README/docs/runbooks
  (direct fixes) and historical audits/plans (dated correction notes, not
  rewrites); fixed the false "moved OUT of CI" pre-push comment.
- **Task 14** — deleted the zombie `preview-env-isolation.yml` gate (checked
  decommissioned Vercel projects, always exited 0); corrected
  docs/DEPLOYMENT.md's claim that it enforced anything; swept a related dead
  `.env.production.example` Vercel-vars fossil.
- **Task 15** — widened the Unit Tests job's vitest glob from
  `apps/web/src/lib` to `apps/web` (fixes 4 orphaned tests) and added a new
  `orphan-tests` CI job that diffs the full vitest-discoverable test set
  against the union of what CI actually runs, failing the build on any
  future orphan. Verified both directions locally (0 orphans; a synthetic
  orphan was caught and cleaned up).
- **Task 16** — added a notify-failure job to `lighthouse-nightly.yml`
  (7 weeks red, unnoticed) + a best-effort no-sudo Chrome install
  (unverified against the live runner — next scheduled run settles it);
  corrected `load-test-nightly.yml`'s header to stop claiming a live nightly
  staging target that was retired 2026-06-13, without deleting the (real,
  working) k6 tooling.
- **Task 17** — removed gitleaks' blanket test-tree path allowlist (verified
  clean via full-history `gitleaks detect`, fixed 3 real gaps it was
  masking); removed `.gitleaks.toml`/`.gitleaksignore` from CI's docs-only
  filters; added `E2E Tests` + `Client secret scan` to main's required
  status checks via `gh api` (verified); added an `AUDIT_RAN` sentinel to
  `scoped-audit.yml`/`audit.mjs` so "model never ran" now alerts (PR comment
  + step summary + Telegram) instead of looking identical to "model ran,
  found nothing."

- **Task 18** — replaced `FIXES.md` with a 5-line pointer (was a 4-month-old
  fossil presenting fixed P0s as open); refreshed this file; re-ran Stryker
  (24s, real measurement: 10.65% overall, up from 9.34%) and set
  `thresholds.break: 10` as a ratchet floor + added a manual
  `mutation-testing.yml` CI job (verified: break=10 passes, break=90 fails
  locally); wired the Playwright smoke suite into `cf-deploy.yml` as a
  post-deploy job (chromium storefront+admin projects, feeds the existing
  Telegram alert) and fixed its stale `app.forcemediakw.com` admin default
  to `admin.force-ai.co` (verified: 5/5 smoke tests green against live prod
  with the corrected default).
- **Task 19** — added a dated "Correction (2026-09-02)" block to
  `docs/audits/2026-08-31-reel-derived-lenses.md`: L16 (RLS) re-marked
  PASS-provisioned/INERT-in-prod (verified prod still connects as
  `neondb_owner`, `rolbypassrls=true`, and the cutover's Phase-1 plumbing is
  still not on `main`); L20 re-marked FAIL (Sentry is error tracking, not
  SLO/burn-rate alerting — verified zero SLO/burn-rate/error-budget code
  anywhere in the repo). Original table rows kept intact with strikethrough
  + a pointer, not silently rewritten. Standing rule recorded in the file
  (not propagated to `force-ai-foundation`'s lens-pack source — that repo is
  outside this worktree).

## Left to do

- Report back to the user per the task instructions (per-task done/partial/
  not-applicable, blast-radius grep results, anything the plan claimed that
  turned out wrong, anything needing Ahmad). Do not push, open a PR, or
  merge.
- All 7 tasks (13-19) are done as of this commit. Nothing else left on this
  branch unless the user's review turns up something.

## Notes

- Root checkout stays on `main`, read-only. This is its own worktree per
  task; don't touch `__fix-audit-p0-security` or `__fix-audit-p1-correctness`
  from here — other work is live there.
- Blast-radius grep after every task, result stated in the commit + the
  final report.
