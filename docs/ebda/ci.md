# Ebda CI: lanes and the minutes budget

The `Ebda-AI-Studio` org is on **GitHub Enterprise: 50,000 GitHub-hosted Actions minutes per month** (the old
"GitHub Free, 2,000 minutes" premise is stale since 2026-11-05). Ruling CI-FULL-MAIN-1 (2026-11-10): pull requests
stay fast (lint, typecheck and unit tests for the paths that changed, plus the guards and the workerd boot smoke),
and **main always carries a recent full run**: every push to main, a nightly cron and the Sunday cron run the full
lane (build, integration, the whole workerd suite, e2e, audit), mutation on Sundays. A red full lane on main opens
or updates ONE GitHub issue labelled `ci-main-red` (plus the Telegram alert); the next green full run closes it.
Every `runs-on` reads `vars.EBDA_RUNS_ON` and falls back to hosted `ubuntu-24.04`
(`tests/unit/workflow-hosted-runners-only.test.ts`); schedules run whether or not that variable is set (the
CI-HOSTED-1 scheduled no-op is retired).

> **Integration on pull requests (2026-10-25, #227).** The integration tier is still a main-lane job, but a PR now runs it
> when `scripts/ci-affected.mjs` selects it: a changed `tests/integration/*.test.ts` runs that file; a changed file under
> `apps/api/src` runs the integration tests that import it (the services/routes/middleware they cover); a changed shared
> fixture/helper or anything under `packages/database` runs the whole tier. Outputs `integration` and `integration_paths`
> feed the `Integration Tests` job's `if` and its vitest targets. #227 merged four edited integration tests that never ran.

## Per-PR runner routing (Ruling CI-ROUTE-1)

A pull request labelled `ci-umbra` runs every job of every PR workflow on the Umbra runners; unlabelled PRs and all
push/schedule events use `vars.EBDA_RUNS_ON` (unset = GitHub-hosted `ubuntu-24.04`). One PR never splits across runners, and
the setup-node remote cache is used only when the job really runs hosted. Add the label before the push, or re-run the
workflow after labelling (`labeled` is not a trigger, so label changes cost no minutes). If Umbra is down, remove the label.

## Lanes

| Trigger                     | Runs                                                                                                                                                                                                                                                                                                                                                                                          |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pull_request` to main      | `changes`, `guards` (migration order, action pins, client secret scan, no-Ebda Store-branding test, prettier on changed files), `lint`, `typecheck`, `unit` (affected paths), `worker-dry-run` (see below); plus gitleaks, blast-radius                                                                                                                                                       |
| push to `main`              | the FULL lane except mutation: `guards`, `build` (full lint, typecheck, format, build), `test-unit` (full, with coverage), `orphan-tests`, `test-integration`, `api-workerd-smoke` (the whole `apps/api/workers-test` suite, route-sweep included), `workerd-integration`, `test-e2e`, `builder-e2e`, `security`, `notify-failure`; a newer push cancels a superseded main run; plus gitleaks |
| nightly cron, Mon-Sat 01:17 | the full lane (same as a main push)                                                                                                                                                                                                                                                                                                                                                           |
| weekly cron, Sun 01:17      | the full lane + `mutation`; semgrep at 01:47                                                                                                                                                                                                                                                                                                                                                  |
| `workflow_dispatch`         | the full lane; mutation only if the `mutation` input is ticked                                                                                                                                                                                                                                                                                                                                |

`scripts/ci-affected.mjs` decides what a PR touches. A changed file maps to its
workspace plus every workspace that depends on it (from `package.json`); a
change to `packages/shared`, `packages/database` or any root config file means
all workspaces; docs-only changes select nothing; `tests/`, `scripts/` and
`.github/` run the unit tiers without per-app lint or typecheck.

`worker-dry-run` (`wrangler deploy --dry-run` on Node 22) runs only for a Worker
app whose deploy surface changed: its `package.json`, wrangler / next /
open-next config, Worker entry (for `apps/web` also every local module that
entry bundles: the two HTML edge caches, `edge-build-id.ts` and the rest of its
relative imports), or the root manifest, lockfile and `cf-*` scripts. It costs about 9 billed minutes per Next app (OpenNext build), so it
is not run for ordinary source edits. Apps without a wrangler config (apps/api
today) are skipped, not failed.

### Main push runs the heavy suite (Ruling CI-FULL-MAIN-1)

Until 2026-11-10 a main push ran only the guards and the heavy tiers ran weekly, to fit 2,000 minutes. With the
`EBDA_RUNS_ON` variable unset the weekly run was a silent no-op (Ruling CI-HOSTED-1), so no full or e2e run passed
on main between at least 2026-10-27 and 2026-11-10. With 50,000 Enterprise minutes the full lane now runs on every
main push (one concurrency group, `cancel-in-progress`, so a burst of merges runs the newest commit only) and
nightly. Residual: a cancelled superseded main run also skips that commit's post-merge migration-order arm; the
newer commit's guards and every PR's own guard still check ordering.

## Minutes budget

Budget: **50,000 Actions minutes/month** (GitHub Enterprise on the `Ebda-AI-Studio` org; Linux 1x; private-repo
hosted runners are 2 vCPU).

**Full lane, measured** (run 42827770627, 2026-11-10, the first GREEN full run, hosted `ubuntu-24.04`, wall time
per job; jobs run in parallel after `build`, so the run takes about 34 minutes end to end while billing about 95):

| Job                       | Wall (measured)                                    | Billed (rounded up) |
| ------------------------- | -------------------------------------------------- | ------------------- |
| guards                    | 1m32s                                              | 2                   |
| security                  | 1m45s                                              | 2                   |
| api-workerd-smoke (whole) | 4m16s                                              | 5                   |
| workerd-integration       | 2m09s                                              | 3                   |
| build                     | 9m18s                                              | 10                  |
| test-unit                 | 20m05s (28m39s in the next green run, 42829048643) | 21-29               |
| test-integration          | 24m26s                                             | 25                  |
| orphan-tests              | 1m53s                                              | 2                   |
| test-e2e                  | 2m19s                                              | 3                   |
| builder-e2e               | 20m03s                                             | 21                  |
| notify-failure            | 0m03s                                              | 1                   |
| **Full lane**             |                                                    | **95**              |
| mutation (Sundays only)   | not measured                                       | 25 (old estimate)   |

Monthly arithmetic (estimates built on the measured per-run number):

| Item                                      | Calculation        | Minutes   |
| ----------------------------------------- | ------------------ | --------- |
| nightly Mon-Sat + Sunday full lane        | 30 x 95            | 2,850     |
| Sunday mutation                           | 4.3 x 25           | ~110      |
| full lane per main push, 60 merges/month  | 60 x 95            | 5,700     |
| full lane per main push, 351 merges/month | 351 x 95 (ceiling) | 33,345    |
| PR lane + deploys + other workflows       | measured           | see below |

Measured context: the org used **9,050 Actions minutes from 2026-11-05 to 2026-11-10** (billing usage API;
8,646 of them on ebda-store, 5,120 on 2026-11-09 alone), during the pre-launch merge burst of **351 merged PRs in
the 30 days to 2026-11-10**. So:

- At a post-launch pace of about 60 merges a month the new lanes add **about 8,700 minutes/month** on top of the PR
  lane and deploys: it fits with wide headroom.
- At the pre-launch burst rate the per-push full lane alone could reach **about 33,300/month** (ceiling: docs-only
  pushes skip the workflow, and a newer main push cancels the superseded run, so bursts of merges bill one run),
  which together with the PR lane can approach the 50,000 cap. Watch Settings, Billing, Actions usage weekly.
- Lever if usage trends past 40,000 by mid-month: move the per-push full lane to an hourly cron that runs only when
  main moved (keeps "a recent full run" within an hour), and keep the nightly. Do not drop the nightly.
- Artifacts (coverage, e2e results, 7-day retention) count against storage, not minutes.

## Making the workflows run at all

GitHub currently reports **zero workflows** on `whisky-11/ebda`. Workflows only
register when:

1. **Actions is enabled** on the repo (Settings, Actions, General: allow actions
   and reusable workflows; GitHub Free private repos have it on by default, but a
   fork or org policy can disable it).
2. **The default branch is `main`** and the workflow files are on it. Scheduled
   (`cron`) and `workflow_dispatch` runs only ever execute the default branch's
   copy, and the Actions tab lists a workflow only once its file exists there.
   Until the lean-CI commit is merged to `main`, nothing appears, and the nightly
   and Sunday runs cannot start.
3. After the first merge, add the PR checks you want required in branch
   protection: `Repo guards`, `Lint`, `Type Check`, `Unit Tests (affected)`,
   `Scan for leaked secrets`. Jobs skipped by `if:` report as skipped (passing),
   so a docs-only PR is not blocked.

Optional secrets: `TELEGRAM_BOT_TOKEN` and `TELEGRAM_ALERT_CHAT_ID` enable the
failure alerts on main and cron runs; without them the notify jobs skip.
`vars.OPENNEXT_CACHE` is read by the Worker dry-run, as in the deploy workflow.
