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
   - Railway → the `force-website-builder` project → **Settings → Tokens** → create a
     **Project token** scoped to the **`production`** environment. Copy it.
   - GitHub → repo **Settings → Secrets and variables → Actions**:
     - **Variable** `RAILWAY_ACTIONS_DEPLOY` = `true` — this is what switches the job on.
     - **Secret** `RAILWAY_TOKEN` = the project token.
     - **Variable** `RAILWAY_SERVICE` = the exact service name of the API service (as shown
       in the Railway project). The service is named **`api`** (verified via the Railway
       API — the _project_ is `force-website-builder`, the _service_ inside it is `api`),
       which is the workflow default; set `RAILWAY_SERVICE` only if that ever changes.
     - (optional) `RAILWAY_ENVIRONMENT` (default `production`), `RAILWAY_HEALTH_URL`
       (default `https://api.force-ai.co/health`).

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
  `api.force-ai.co/health`; once this cutover is live, its Railway recovery becomes a true
  rollback-to-last-good instead of redeploy-from-source.

## Rollback of the cutover itself

Re-enable "Deploy on push" in Railway and the GitHub App resumes deploying; the Actions
workflow goes back to a skipped job once `RAILWAY_ACTIONS_DEPLOY` is unset or set to
anything other than `true`. Fully reversible, and the rollback is a variable rather than a
secret so it needs no token handling.
