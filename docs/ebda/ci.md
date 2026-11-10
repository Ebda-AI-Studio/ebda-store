# Ebda CI: lean lanes and the minutes budget

Ebda is a private repo on GitHub Free: **2,000 GitHub-hosted Actions minutes per
month**, Linux 1x. Ahmad's decision: CI is lean from the first commit; pull
requests run only lint, typecheck and unit tests for the paths that changed;
integration, E2E and mutation tests run on main or nightly. Nothing depends on
Umbra (Ebda Store's self-hosted runner): every job is `runs-on: ubuntu-latest`, and
`tests/unit/workflow-hosted-runners-only.test.ts` fails the build if a
self-hosted label, `vars.USE_SELF_HOSTED` or `SCHEDULED_ON_CLOUD` reappears.

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

| Trigger                     | Runs                                                                                                                                                                                                                                          |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pull_request` to main      | `changes`, `guards` (migration order, action pins, client secret scan, no-Ebda Store-branding test, prettier on changed files), `lint`, `typecheck`, `unit` (affected paths), `worker-dry-run` (see below); plus gitleaks, blast-radius       |
| push to `main`              | `guards` only (lite: no install) and gitleaks. The merge commit already passed its PR.                                                                                                                                                        |
| nightly cron, Mon-Sat 01:17 | ebda_app strict-RLS proof (`test-rls-ebda-app`, the R-EBDA-001 gate)                                                                                                                                                                          |
| weekly cron, Sun 01:17      | everything in the full lane: `build` (full lint, typecheck, format, build), `test-unit` (full, with coverage), `orphan-tests`, `test-integration`, RLS proof, `test-rls-payload-parity`, `test-e2e`, `security`, `mutation`; semgrep at 01:47 |
| `workflow_dispatch`         | the full lane; mutation only if the `mutation` input is ticked                                                                                                                                                                                |

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

### Deviation from "main push runs the heavy suite"

The first draft put build, integration, RLS, e2e and audit on every main push.
At 60 merges a month that alone is about 3,400 minutes, so it cannot fit.
The heavy tiers therefore run on a cadence, not a trigger: nightly for the RLS
gate, weekly for the rest. The cost is detection latency: a break that only a
heavy tier sees (an integration regression, a semantic merge conflict between
two PRs) is found within a day (RLS) or a week (the rest), not at the merge.
Turn on "Require branches to be up to date before merging" in branch protection
to shrink the semantic-conflict window. To run a tier on every push instead,
change its job `if:` and re-check the budget below.

## Minutes budget

All figures are **estimates, not measurements**. Assumptions: `ubuntu-latest`
(2 vCPU) on a private repo, 1x multiplier, every job rounded up to a whole
minute, warm npm cache (`setup-node` `cache: npm`), the unit suite at about
2.5 minutes of vitest (the 6,100-test `tests/unit` took about 3 minutes
single-core locally). Replace them with real numbers after the first week
(Settings, Billing, Actions usage).

Billed minutes per run:

| Run                                                    | Jobs (billed min)                                                                                      | Total |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ | ----- |
| PR, docs-only                                          | changes 1, guards 3, gitleaks 1                                                                        | 5     |
| PR, typical code change (one app or package)           | docs-only 5, blast-radius 1, lint 3, typecheck 4, unit 6                                               | 19    |
| PR, Worker config change (one Next app)                | typical 19, worker-dry-run 9                                                                           | 28    |
| PR, shared / database / root config (all workspaces)   | docs-only 5, blast-radius 1, lint 6, typecheck 6, unit 7                                               | 25    |
| PR, root `package.json` or lockfile (all, all Workers) | all 25, worker-dry-run: 3 Next apps x 9, marketing 6, status 3                                         | 61    |
| Push to main                                           | guards-lite 1, gitleaks 1                                                                              | 2     |
| Nightly, Mon-Sat                                       | RLS proof 6                                                                                            | 6     |
| Weekly, Sunday (full lane)                             | build 12, unit 6, orphan 5, integration 10, RLS 6, parity 5, e2e 7, security 6, semgrep 4, mutation 25 | 86    |

Monthly total at **60 PRs, 60 main pushes, 25 nightlies, 5 Sundays**:

| Item                                  | Calculation | Minutes   |
| ------------------------------------- | ----------- | --------- |
| 15 docs-only PRs                      | 15 x 5      | 75        |
| 32 typical code PRs                   | 32 x 19     | 608       |
| 5 Worker-config PRs                   | 5 x 28      | 140       |
| 5 shared / database / root-config PRs | 5 x 25      | 125       |
| 3 manifest or lockfile PRs            | 3 x 61      | 183       |
| 60 pushes to main                     | 60 x 2      | 120       |
| 25 nightly RLS runs                   | 25 x 6      | 150       |
| 5 weekly full runs                    | 5 x 86      | 430       |
| **Total**                             |             | **1,831** |

That is 92% of 2,000: it fits, but with about 170 minutes of headroom, not
"comfortably". Sensitivity and levers:

- Each extra typical PR costs about 19 minutes; break-even is about 69 PRs a month.
- Mutation is the biggest guess (5 x 25 = 125). Making it manual-only
  (`mutation` input) gives 1,706.
- Cheapest further savings: run semgrep monthly, drop `blast-radius` (about 45),
  fold `lint`, `typecheck` and `unit` into one PR job (shares one install, saves
  about 3 minutes per code PR but loses parallelism).
- If usage trends past 1,700 by mid-month, stop the Sunday full lane for a week
  rather than letting PR checks start failing for lack of minutes.
- Artifacts (coverage, e2e results, 7-day retention) count against the separate
  500 MB storage quota, not minutes.

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
