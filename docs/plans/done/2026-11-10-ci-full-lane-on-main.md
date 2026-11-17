# CI: full lane on every main push + nightly (2026-11-10)

Ruling CI-FULL-MAIN-1. Launch is 2026-11-11.

**What must work:** main always has a recent, passing FULL run (build, full lint/typecheck, full unit, integration, workerd incl. route-sweep, e2e, audit).
**Exercised:** `ci.yml` on push / schedule / dispatch; full run 42818774650 on main; a dispatch of the full lane on this branch.
**Must NOT change:** the PR lane (affected-only), the merge gate's required checks, the deploy workflows.
**Done when:** a full run on main is green (or every red job has a fix PR), the workflow PR's own checks are green, and its dispatched full lane is green.

## Steps

1. Watch run 42818774650; for each failing job find the root cause and fix it (product bug fixed, flaky test made deterministic).
2. `ci.yml`: build/security `if: github.event_name != 'pull_request'` (retire the CI-HOSTED-1 scheduled no-op); mutation = Sunday cron or ticked dispatch; crons `17 1 * * 1-6` + `17 1 * * 0`.
3. `api-workerd-smoke` runs on every event and the whole `workers-test` suite outside a PR; `workerd-integration` always in the full lane.
4. Concurrency: one group for main pushes (`cancel-in-progress`), PR per ref, cron/manual per run.
5. `notify-failure`: also needs the workerd jobs; on a main failure opens/updates the `ci-main-red` issue; a green main full run closes it.
6. Tests: `tests/unit/ci-lean-structure.test.ts` evaluates each job's `if:` per event (push = full lane minus mutation; nightly; Sunday + mutation); merge-gate required list unchanged.
7. Docs: header comment, `docs/ebda/ci.md` (Enterprise 50k minutes, measured timings, monthly estimate), ruling file (no README row: Ruling RULINGS-INDEX-1).
