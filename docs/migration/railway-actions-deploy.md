# Railway API deploy → GitHub Actions (cutover)

Moves the Express API off **Railway's GitHub App auto-deploy** onto **GitHub Actions**
(`.github/workflows/railway-deploy.yml`, `railway up`). The frontends already deploy
this way (`cf-deploy.yml` → `wrangler deploy`); this brings the API to the same
pipeline-as-code model.

## Why

The Railway GitHub App is an OAuth-wired dashboard integration — it is **not in the
repo**, not reviewable, and **it silently broke on the 2026-07 org migration** (the
CF Workers Builds integration broke the same way). An Actions deploy:

- **survives org/account moves** — it only needs the repo secret, which transfers automatically;
- is **version-controlled + reviewable** (the deploy IS code);
- gives a clean place to **verify** (post-deploy `/health` gate) and, once combined with
  the self-heal medic, a scriptable **rollback-to-last-good** path.

Migrations are unchanged — `railway.json`'s `preDeployCommand` (`prisma migrate deploy`)
still runs on Railway before the new replica is promoted, regardless of what triggers the deploy.

## Safe by default

`railway-deploy.yml` is **gated on the `RAILWAY_ACTIONS_DEPLOY` repo variable**, at job
level. Until it is set to `true` the deploy job is reported as **skipped** — a grey
square, not a green tick.

That distinction is the point. The gate used to live inside a step: the job ran, wrote a
warning, deployed nothing and reported **success**. Every push to `main` therefore showed
a green "Deploy API (Railway)" that was indistinguishable from a real deploy, which is
exactly the signal you would rely on to answer "did it ship?". A skipped job answers that
honestly; a green one lied.

Once the variable IS `true`, a missing `RAILWAY_TOKEN` **fails** the job rather than
skipping it. After cutover an absent token is a misconfiguration, and the one thing it
must not do is quietly go back to deploying nothing.

**Post-cutover hazard (#1490):** the job-level gate that makes a _pre-cutover_ run safe
(grey skip, not a lying green tick) reopens the identical risk one door over if
`RAILWAY_ACTIONS_DEPLOY` is ever lost, mistyped (`True`/`TRUE`/`1`) or unset **after**
cutover — the job silently skips again, and `notify-failure` (`needs: deploy`,
`if: failure()`) skips right along with it, because a skipped dependency never satisfies
`failure()`. Every push to `main` would then deploy nothing and alert nobody, with only a
grey square on a workflow nobody is watching. `railway-deploy-drift-check.yml` is the
independent safety net for exactly this. Every 30 minutes — **not** gated on
`RAILWAY_ACTIONS_DEPLOY`, since a monitor that skips with the variable it watches is blind
to that variable's loss — it alerts on Telegram and fails when:

1. `RAILWAY_ACTIONS_DEPLOY` is set to a truthy-looking value that is not exactly `true`
   (`True`, `TRUE`, `1`, `yes`, `on`) — a pure config check, no network call;
2. the commit `/health` reports is **not an ancestor** of `main` (rollback, branch deploy,
   force-push); or
3. the live commit **is** an ancestor of `main`, but `main` carries commits on the deploy
   job's own trigger paths (`DEPLOY_PATHS`, kept equal to `railway-deploy.yml`'s
   `on.push.paths` by a unit test) that have not gone live, and the oldest of them landed
   more than **90 minutes** ago or more than **10** of them are waiting. This is the
   stalled-pipeline case: a pipeline that stopped deploying leaves the live commit
   permanently an ancestor of `main`, which the check used to accept forever.
4. it cannot see (issue 2205): `/health` is unreachable or not JSON after 3 attempts, or
   answers with `commit: null`. Neither is drift and the alert says so — but both used to
   warn and exit 0, and the commit stamp is deliberately non-fatal, so a broken stamp
   would have left this monitor green and blind forever.

Commits outside the deploy paths never trigger a deploy, so they are never "undeployed".
`/health` reports the live commit whichever pipeline deployed it (Railway's own
auto-deploy stamps `RAILWAY_GIT_COMMIT_SHA` pre-cutover), so the comparison is meaningful
before and after the cutover. It never touches the deploy job's own gate.

## Before the cutover — prove the deploy path once

**Do this while Railway's own auto-deploy is still enabled**, so the API keeps a working
deploy path if it fails.

1. Set `RAILWAY_ACTIONS_DEPLOY` = `true` and add the `RAILWAY_TOKEN` secret.
2. Run the workflow manually (`workflow_dispatch`) and watch it finish.
3. Confirm the **Stamp the commit being deployed** step succeeded — and check something
   the platform cannot satisfy on its own.

   A green **Verify the deployed build is THIS commit** is **no longer sufficient
   evidence.** Railway injects its own `RAILWAY_GIT_COMMIT_SHA` at runtime (verified
   2026-09-03), so while its auto-deploy is still enabled it deploys the same push and
   reports the same sha — the verify step goes green with the stamp step having
   accomplished nothing. That is the "green tick that deployed nothing" class this
   project already gates against elsewhere, and it would be the evidence for an
   irreversible step.

   So confirm instead that **`GIT_COMMIT_SHA` is now present as a Railway service
   variable, set to the deployed sha**:

   ```bash
   railway variables --kv --service api | grep '^GIT_COMMIT_SHA='
   ```

   Only the Actions stamp step writes that variable. If it is absent, the step did not
   work no matter how green the verify looked.

Only then do the two steps below. A CLI invocation that is correct in a terminal is not
thereby correct in the job — the Railway CLI is pinned in the workflow for exactly this
reason, and a subcommand that does not exist would exit non-zero at the stamp step
**before** `railway up`, leaving the API with no deploy path at all. That is the state
this whole runbook exists to avoid, so it is worth one dispatch run to rule out.

## Cutover — 2 steps (do them together)

Doing only one causes trouble: token without disabling auto-deploy → **double deploys**;
disabling auto-deploy without the token → **no deploy path**. So:

1. **Add the deploy token**
   - Railway → the `ebda-store` project → **Settings → Tokens** → create a
     **Project token** scoped to the **`production`** environment. Copy it.
   - GitHub → repo **Settings → Secrets and variables → Actions**:
     - **Variable** `RAILWAY_ACTIONS_DEPLOY` = `true` — this is what switches the job on.
     - **Secret** `RAILWAY_TOKEN` = the project token.
     - **Variable** `RAILWAY_SERVICE` = the exact service name of the API service (as shown
       in the Railway project). The service is named **`api`** (verified via the Railway
       API — the _project_ is `ebda-store`, the _service_ inside it is `api`),
       which is the workflow default; set `RAILWAY_SERVICE` only if that ever changes.
     - (optional) `RAILWAY_ENVIRONMENT` (default `production`), `RAILWAY_HEALTH_URL`
       (default `https://api.ebda.app/health`).

2. **Disable Railway's own auto-deploy** (so Actions is the only deployer)
   - Railway → project → the API service → **Settings → Deploys / Source** → turn **off**
     "Deploy on push" / disconnect the GitHub trigger (keep the service + env vars — only the
     auto-deploy-on-push trigger is being removed).

Then push any change under `apps/api/**` / `packages/**` (or run the workflow via
**Actions → Deploy API (Railway) → Run workflow**) and confirm: the Actions run deploys and
the **Verify the deployed build is THIS commit** step goes green.

That step waits for `/health` to report the commit being deployed, not merely a 200. A 200
is returned just as cheerfully by the container still running the PREVIOUS release, so the
old check passed on a deploy that never landed. If `/health` reports `commit: null` the
build was never told its commit — the step warns and passes, because unknown is not the
same as wrong. Populating it is automatic once this workflow deploys: the **Stamp the commit being
deployed** step sets `GIT_COMMIT_SHA` as a Railway service variable to the commit being
deployed, and `Dockerfile.api` bakes it in as `BUILD_COMMIT_SHA`. Railway builds the image
itself, so a build arg cannot be passed from the CLI — a service variable is how the value
reaches the build.

**Never set `GIT_COMMIT_SHA` to a fixed value by hand.** It has to change per deploy; a
static one makes `/health` report a commit that is not the one running, which is a
confident lie and strictly worse than the `null` it replaces.

**Verified 2026-09-03 — both platform variables ARE injected at runtime.** The first
deploy carrying `/health`'s build identity reported the correct `commit` and a non-null
`deploymentId` with no build arg supplied and no service variable set. That also clears
the Inngest deploy sync, which reads `RAILWAY_DEPLOYMENT_ID` through a `||` fallback
chain — a chain falling through would have looked identical from outside.

Neither variable appears in **either** listing: not in the ~85 the CLI reports for the
service, nor in the 8 the dashboard shows as "added by Railway". Those two counts are
different measures — total configured vs. platform-added — and neither describes the
environment the container actually receives, which is a third thing only a running
process can report. Do not read absence from either list as absence from the process.

## Rollback (post-cutover)

- **Fast (Railway):** `railway redeploy` a prior good deployment, or in the dashboard
  redeploy an earlier successful deploy.
- **Code:** `git revert HEAD && git push` → the workflow redeploys the reverted commit.
- **Autonomous:** the self-heal medic (`~/.claude/scripts/self-heal.sh`) monitors
  `api.ebda.app/health`; once this cutover is live, its Railway recovery becomes a true
  rollback-to-last-good instead of redeploy-from-source.

## Rollback of the cutover itself

Re-enable "Deploy on push" in Railway and the GitHub App resumes deploying; the Actions
workflow goes back to a skipped job once `RAILWAY_ACTIONS_DEPLOY` is unset or set to
anything other than `true`. Fully reversible, and the rollback is a variable rather than a
secret so it needs no token handling.

**Also delete the `GIT_COMMIT_SHA` service variable** (#1495). The "Stamp the commit"
step writes it as a _persistent_ Railway service variable, overwritten only by the next
Actions-triggered deploy. Once the GitHub App resumes deploying (or anyone runs
`railway up` from a developer machine), the image is rebuilt by a path that never touches
this variable, so it keeps baking the LAST Actions-set commit into the build and
`/health` reports a frozen, increasingly-wrong `commit` forever — a confident lie, not
the `null` a rolled-back cutover should read as. Delete it from the service
(`railway variable delete GIT_COMMIT_SHA --service <service> --environment <environment>`,
or via the dashboard) as part of the rollback.

## The hourly probe: one script, sequenced after deploy (issue 2176 / 2191)

Both admission probes — the deploy job's post-deploy step and the hourly
`guest-checkout-probe` job — run `scripts/guest-checkout-admission-probe.sh`, so the
bounded retry on `000`/`429`/`5xx` covers the copy that runs 24x/day against production
too (it had been left as a single-curl inline copy). The probe job `needs: deploy` with
`!cancelled()`, so a `workflow_dispatch` no longer fires it mid-swap; on the cron the
deploy job is skipped and the probe still runs. It stays on the repo's runner expression:
cloud minutes are billing-blocked, and a run that never starts on an offline self-hosted
runner is caught outside Actions by `ci-runner-guard.sh` (Ruling CI-PROBE-1).

## Concurrency: the hourly probe has its own group (2026-09-30)

`cancel-in-progress: false` protects only the RUNNING run. GitHub keeps one
PENDING run per concurrency group and cancels the older pending run when a new
one queues. The hourly `guest-checkout-probe` cron used to share the
`railway-deploy` group, so a push deploy queued behind a running deploy could be
cancelled by the next cron run, which skips the deploy job — stranding that API
change (the same class as cf-deploy's HEAD~1 bug). Scheduled runs now use
`railway-deploy-probe`; push and dispatch runs use `railway-deploy-deploy`. Push
runs may still replace one another while pending, which is safe: `railway up`
ships the whole tree at HEAD, so the newer run carries the older one's changes.
Pinned by `tests/unit/cf-deploy-detect-since-last-success.test.ts`.
