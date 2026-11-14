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

## Ruling PR-CI-CHEAP-1 (2026-11-14): PRs pay for what they touch

Measured: ~11 approved PRs queued behind two heavy Mac runners. Changes (all in `ci.yml`):

- **PR unit tests are ONE job when the affected set is narrow** (`Unit shard 1/1 (affected)`): the setup (npm ci, builds, Chromium,
  heavy lock) was paid three times for a few minutes of tests. When `ci-affected.mjs` reports `all` (root config, packages/shared or
  packages/database changed = the whole suite) the same job keeps 3 shards (`Unit shard i/3 (affected)`). The total comes from
  `changes.outputs.all` (`UNIT_SHARDS`), never a literal. Main/nightly keep the 3 coverage shards (`test-unit-shard`). Check name
  `Unit Tests (affected)` unchanged.
- **Lint and Type Check run on the light runner** (`EBDA_LIGHT_RUNS_ON`, GitHub Linux): no workerd or macOS need.
- **`API Worker boots on workerd` (merge-gate REQUIRED) is a fast pass only when it provably cannot matter.** The job keeps no `if`
  (derived required list unchanged). Its first step runs `scripts/ci/api-smoke-scope.mjs` (node builtins only, base commit fetched at
  depth 1): the boot is SKIPPED only when EVERY changed file is on a short allowlist (docs/**, \*.md, apps/{web,admin,marketing,help,
  docs,orders}/**, tests outside integration/workers). Anything else (package.json, lockfile, tsconfig, packages/**, wrangler, prisma,
  scripts/**, .github/\*\*, apps/api, an unknown path, an empty or unreadable diff) RUNS it. Every later step is gated on
  `steps.scope.outputs.run`. Pinned by `tests/unit/ci-api-smoke-scope.test.ts` (both directions, gating, no-node_modules imports).
  Push to main, nightly and dispatch always run it whole.
- Concurrency was already cancel-in-progress for PRs only (main gets a group per SHA, never cancelled).
- Unchanged: App build / Worker dry-run / workerd integration / Integration Tests are already gated on the affected outputs;
  the `full-ci` label still dispatches the full lane pre-merge.

Heavy-runner jobs per PR, COMPUTED (not measured runs) by running `scripts/ci-affected.mjs --files` on each PR's real file list and counting the jobs the workflow would start, before -> after: docs-only (#759) 1 -> 0 (+1 seconds-long skip pass);
api-only (#758) 8 -> 4; web-only (#722) 7 -> 2 (+1 skip pass).

## Ruling CI-SLIM-1 (2026-11-12): 3 unit shards + an opt-in pre-merge full tier

Measured on the Mac (10 cores, 16 GB, load ~10.7, heavy jobs serialised by `heavy-lock.sh`): a code PR push runs 15-20 jobs;
the per-run sum of job durations on 5 recent PR runs was 2,847-3,976 s wall, of which 682-1,149 s was waiting for the
heavy lock, leaving **1,709-2,859 s (avg 2,303 s, 38 min) of real heavy-runner work**. The unit shards (6 + workerd extras
= 7 jobs) were 1,163-1,451 s of that (avg 1,278 s); every job repeats ~60 s of checkout + `npm-ci` + prisma/shared builds.

- **3 shards instead of 6 + 1.** `Unit shard i/3` (i = 1..3) in both the PR lane (`unit`) and the full lane (`test-unit-shard`);
  the workerd extras (editor matrix, status, accounts, prisma-lite DO) run as the tail of shard 3 (`!cancelled()`, so they
  still run when the vitest step failed). Setup is paid 3 times, not 7: about 4 x 60 s = **~4 min of heavy work and four
  lock turns saved per PR push**. Total vitest time is unchanged (same files), so this is an overhead cut, not a speed-up
  of the tests; shard 3 carries ~1 min more than 1 and 2. The blob reports are still `unit-blob-<n>`, merged by `Unit Tests`.
- **Pre-merge full tier, opt-in by label `full-ci`** (`.github/workflows/ci-full-pr.yml`). Adding the label (or pushing while
  it is on the PR) dispatches `ci.yml` (`workflow_dispatch`, the existing full lane) on the PR branch; the checks attach to
  the head sha, so `ops/merge-gate.sh` sees them and refuses on a failure. Use it for PRs that touch money, auth, data,
  migrations or anything the AI review marks `risky-path`, once, just before merge. A new full dispatch on the same branch
  cancels the previous one (`ci.yml` group `ci-full-<ref>`); a dispatch on a PR branch never pages Telegram and never opens
  `ci-main-red`. Mutation stays Sunday / manual.
  Why not automatic on `ai-review-passed`: that label is added with `GITHUB_TOKEN`, which raises no event, and one full run is
  ~7,200 s wall (measured: main runs 42990056432 and 43028985811, 7,297 s and 7,168 s) - with ~3,200 s per PR push the host
  cannot afford it as a default. Cost if wrong: a risky PR merged without `full-ci` is first proven by the push-to-main full run.
- **Required checks are unchanged**: `Repo guards`, `Detect affected workspaces`, `Unit Tests (affected)`, `App builds
(affected)`, `API Worker boots on workerd` (derived by `ops/merge-gate-required.mjs`). The full-tier checks are not
  required (they exist only when `full-ci` was used); `ci-full-pr.yml:dispatch` is a light job (pinned in
  `workflow-hosted-runners-only.test.ts`). The only renamed checks are the matrix names `Unit shard i/6` -> `Unit shard i/3` and
  `Unit workerd extras` (gone); neither is required or listed in the `ebda-main-protection` ruleset.
- **Concurrency**: PR runs were already one group per PR ref with cancel-in-progress; unchanged.

## The Mac runner (Ruling CI-MAC-RUNNER-1, 2026-11-11)

The org's 50,000 hosted minutes ran out on 2026-11-11 (ebda-store used 49,451) and paid add-ons are capped at $0, so
Ahmad chose to run CI on his Mac. **`EBDA_RUNS_ON='["self-hosted","ebda-mac"]'`** (repo variable on ebda-store,
ebda-whatsapp, ebda-foundation) routes every job to the org runners `ebda-mac-1` / `ebda-mac-2` (runner group
`ebda-mac`: those three private repos only, no public repos; org fork-PR workflows for private repos are off).
Delete the variable to go back to hosted `ubuntu-24.04`. Never the Umbra VM.

- **Runner install**: `~/actions-runner-ebda` and `~/actions-runner-ebda-2` (actions/runner v2.338.2, sha256 verified),
  launchd user agents `actions.runner.Ebda-AI-Studio.ebda-mac-{1,2}` (`./svc.sh status|stop|start` in each dir). Their
  `.path` is a clean Homebrew PATH (Homebrew bash 5 first: `/bin/bash` 3.2 breaks `"${arr[@]}"` under `set -u`); `.env` sets
  `PLAYWRIGHT_BROWSERS_PATH=~/.ebda-ci/ms-playwright`, a browser cache ONLY the runners use (never the Actions cache, never
  `~/Library/Caches/ms-playwright`: `playwright install` reads every install registered there, and one under `~/Desktop`
  made the launchd runner block on a macOS privacy prompt for 15+ min, 2026-11-11) and `EBDA_NM_STORE=~/.ebda-ci/node-modules` (the npm-ci-reuse store, shared by both runners). Two instances, not
  more: other orgs' runners on the same Mac count toward a host total of 3.
- **Ruling HOST-RUNNERS-2 (2026-11-11, supersedes the "3 runners per host" cap for Ebda)** - after the switch, 46 runs queued
  on two runners and 10-second label checks waited behind 30-minute suites. Two LIGHT runners were added:
  `~/actions-runner-ebda-light-{1,2}` (`ebda-mac-light-1/2`, label `ebda-mac-light` ONLY, no default labels, so a job
  asking for `["self-hosted","ebda-mac"]` never lands there). `EBDA_LIGHT_RUNS_ON='["ebda-mac-light"]'` routes the cheap jobs
  there: deploy-change label, PR quality (body + slop), blast-radius, gitleaks, AI review (classify / review / manual-pass / fork-gate),
  and CI `changes`, `guards`, `unit-gate`, `app-builds`. Their fallback chain is light var, then `EBDA_RUNS_ON`, then hosted
  `ubuntu-24.04`. None of them takes the heavy lock or a per-job database (pinned by
  `tests/unit/workflow-hosted-runners-only.test.ts`), so heavy work stays at one suite at a time on the two `ebda-mac`
  runners. Host at the time: 10 cores, 16 GB (63% free), 35 GB disk free; the light runners are APFS clones (~0 extra disk
  for binaries). Host total: 4 Ebda runners plus 2 of another org. Cost if wrong: light jobs that turn out heavy would compete with
  the heavy lane for CPU and RAM; the pinned light list is the place to move such a job back.
- **Databases**: macOS runners cannot start service containers, so `services:` images are `''` when `EBDA_RUNS_ON`
  names `ebda-mac` (the runner then skips the service). `scripts/ci/ci-services.sh up` gives the job its URLs
  (`CI_PG_URL`, `CI_PG_APP_URL`, `CI_REDIS_URL`): on Linux from the service ports; on the Mac a database of its own on the
  host's ONE Homebrew Postgres 17 + pgvector (shared with other repos), named `ebda_store_ci_<run>_<attempt>_<job>_<runner>`
  and dropped by `ci-services.sh down` (`if: always()`); `up` also drops this repo's CI databases older than 3 h. Redis is a
  logical DB reserved for Ebda CI on this host per runner instance (14 / 15; other tools use 0, 9, 11, 13). Host deviation: brew ships pgvector 0.8.7, CI's container pins 0.8.0.
- **Heavy jobs one at a time**: the test jobs bind fixed ports (API 4000, web 3000/3001, workerd 8811-8813) and take most of
  the 16 GB, so each heavy job (unit shards, integration, e2e, builder e2e, worker dry-run, workerd smoke/integration,
  mutation) holds the host-wide lock `~/.claude/locks/heavy-test.lock` (`scripts/ci/heavy-lock.sh`, the same file
  `host-lock.sh` uses for local suites) and releases it in its last `if: always()` step. Light jobs (changes, guards, lint,
  typecheck, app builds, gitleaks, blast-radius) run in parallel on the two runners.
- **Ruling CI-MAC-ROLE-1** - on the Mac the workflow never `ALTER`s the cluster-wide `ebda_app` role
  (`ci-services.sh app-login` only checks it can log in, NOT superuser, NOT bypassrls); the host's pg_hba is `trust` on
  localhost, so the password is not what authenticates. The integration suite's own `tests/helpers/app-role-login.ts` still
  sets the same `ci-only-app-pw` the local dev scripts use (no other repo on this host uses `ebda_app`; GCC uses `horse_app`).
  Cost if wrong: a different `ebda_app` password set by another tool on this host would be overwritten during an Ebda run.
- **Ruling CI-MAC-TZ-1** - `ci-services.sh up` runs `ALTER DATABASE <per-job db> SET timezone TO 'UTC'` on the Mac. The host cluster defaults to the
  Mac's zone (UTC+3) while the Linux container is UTC, and the pg adapter writes a Date as a UTC wall-clock string that the session
  zone then reads, so writes outside a tenant transaction (which pins UTC) shifted by the offset: staff-invite-seats fixtures expired in the
  past and every accept returned 400 (main red since the Mac cutover, #720). Only the per-job database is altered, never the shared cluster.
  Cost if wrong: a test that relies on a non-UTC session zone would see UTC on the Mac.
- **No docker on the Mac**: the trufflehog action runs in a container, so `Security Audit` runs it on Linux only and, on the Mac,
  the same release (v3.99.8) natively from `~/.ebda-ci/tools` (checksum re-verified each run, downloaded only on a miss). The AI
  review installs the claude CLI with `--ignore-scripts`, so it links the per-platform native binary itself. The checkout is depth 1, so a push
  deepens to `before` and scans exactly before..after (it fails rather than fall back to a whole-tree scan). Ruling
  CI-MAC-TRUFFLE-1: from the Mac, the `postgres://...@db.example.com` fixtures in `tests/unit/skins-preflight.test.ts`
  report as VERIFIED (main run 43112327669), so `.github/trufflehog-mac-exclude-paths.txt` skips exactly that file there.
  Postgres URLs trufflehog cannot verify are caught by gitleaks' `ebda-postgres-url-password` rule in `.gitleaks.toml`.
  The built-in gitleaks rules do not flag a Neon-shaped URL. The rule ignores loopback hosts, reserved example/test domains
  and placeholders. Both are pinned by `tests/unit/gitleaks-postgres-url-rule.test.ts`.
- **Runner security** - the Mac also runs the main-only deploy workflows, so it holds the Cloudflare deploy token while
  same-repo PR jobs run on the same machine. Deploy secrets live only in the `production` environment, which accepts
  deployments from `main` only (branch policy set 2026-11-11), so a PR-triggered job cannot read them even if a PR edits
  a workflow. Residuals: an org secret visible to all workflows (`CLAUDE_CODE_OAUTH_TOKEN`) is readable by any same-repo PR
  workflow, and a PR job can leave files on the host (node_modules store, npm cache) that a later main job reads.
- Fixed `/tmp` paths are banned in every workflow and in the AI review/audit scripts (`$RUNNER_TEMP` instead; the AI
  review's `CLAUDE_OUTPUT` and its CLI install live there, never `npm install --global`); gitleaks installs the darwin binary into
  `$RUNNER_TEMP/bin` without sudo. Pinned by `tests/unit/ci-lean-structure.test.ts` ("the Mac runner shape").

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
`apps/marketing` is the exception: a static export with no OpenNext build, it
dry-runs on any change under its `src/`, `public/` or `scripts/`, or to
`scripts/ci/marketing-perf-budget.{mjs,json}`, so its page-weight budget fails
the PR that grows it.

In the FULL lane (main push, nightly, dispatch) `worker-dry-run` always runs
for `marketing` alone, so the marketing page-weight budget
(`scripts/ci/marketing-perf-budget.mjs`) is measured on main and a red one
reaches `notify-failure`: it broke unseen on main on 2026-11-10 because only
PRs that touched marketing measured it (Ruling MKT-LEGAL-HTML-BUDGET-2).

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

- **Ruling HOST-RUNNERS-3** (2026-11-12) - the AI `review` job moves to the light runners. It is one CLI install plus one
  tool-less `claude -p --max-turns 1`, with no heavy lock and no database, yet it sat on `ebda-mac` and waited 1-3 h behind
  the heavy suites; every merge is gated on it, so it set the merge rate. Evidence: 2026-11-12 20:30Z, 26 runs queued, both
  `ebda-mac` busy, both `ebda-mac-light` idle. Cost if wrong: a slow review competes with the light lane (bounded by its
  20-minute timeout); move it back by editing `ai-review.yml:review` and the pinned list.

- **Ruling HOST-RUNNERS-4** (2026-11-13) - every job that takes the heavy host lock gets job `timeout-minutes` = its
  run budget + 60, because GitHub counts the lock wait against the job timeout and `heavy-lock.sh` may wait up to
  `HEAVY_LOCK_MAX_WAIT_S` (3600 s). Evidence: #747 `Unit shard 3/3` waited 1771 s for the lock, ran 7948 tests green
  and was cancelled 0.3 s later at the old 35-minute limit. Pinned by `tests/unit/heavy-lock-wait-budget.test.ts`
  (timeout must exceed the lock max wait + 20 min). Cost if wrong: a genuinely hung heavy job holds the lock up to
  60 minutes longer before GitHub kills it.
- **Ruling HOST-RUNNERS-5** (2026-11-13) - all `cf-*-deploy.yml` jobs (plan / deploy / notify-failure) move to the
  light runners. A deploy takes no heavy lock and no database (same as CI `app-builds`, already light), yet the #745
  API deploy sat queued ~70 min behind two heavy suites while both light runners were idle. Cost if wrong: a large
  OpenNext build competes with light checks for the light runners; move back by editing the deploy workflows and the
  pinned light list in `tests/unit/workflow-hosted-runners-only.test.ts`.
- **Ruling AI-REVIEW-HANG-1** (2026-11-13) - the `review` step cuts `claude -p` at 8 minutes (`timeout 480`) and
  retries once; two failures fail the step closed (no label). Evidence: #740's review was cancelled at the 20-minute
  job timeout twice on a 35 KB diff while #742's 257 KB diff passed (network hangs to the model API that day).
  Pinned by `tests/unit/ai-review-hang-bound.test.ts`. Cost if wrong: a slow-but-healthy review over 8 min is retried
  and can fail where it would have finished; raise the bound with this test.
- **Ruling DEPLOY-PLAN-CLONE-1** (2026-11-13) - every `cf-*-deploy.yml` `plan` job checks out with
  `filter: blob:none` (full history, file contents fetched on demand) and a 15-minute limit. Evidence: on a slow link
  (measured 56 KB/s to codeload, 350 KB/s to Cloudflare) the full-history clone ran past the old 5-minute limit and
  cancelled the API deploys for #748 and #740 (runs for b0e2cb22e and eb26f66c0); a cancelled deploy is a deploy that
  did not happen and nothing retries it. `deploy-plan.mjs` needs only trees (`diff --name-only`) plus two lazy
  `git show` of `package-lock.json`, and already deploys when that read fails. Cost if wrong: a blob fetched lazily
  per `git show` on a slow link; worst case the plan deploys when it could have skipped.
