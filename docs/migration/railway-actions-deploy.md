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

`railway-deploy.yml` is **guarded on the `RAILWAY_TOKEN` secret**. With the secret unset
(the state on merge), the workflow logs a warning and no-ops. So **merging this PR changes
nothing** — the API keeps deploying via the Railway GitHub App until you actively cut over.

## Cutover — 2 steps (do them together)

Doing only one causes trouble: token without disabling auto-deploy → **double deploys**;
disabling auto-deploy without the token → **no deploy path**. So:

1. **Add the deploy token**
   - Railway → the `force-website-builder` project → **Settings → Tokens** → create a
     **Project token** scoped to the **`production`** environment. Copy it.
   - GitHub → repo **Settings → Secrets and variables → Actions**:
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
the **Verify /health** step goes green.

## Rollback (post-cutover)

- **Fast (Railway):** `railway redeploy` a prior good deployment, or in the dashboard
  redeploy an earlier successful deploy.
- **Code:** `git revert HEAD && git push` → the workflow redeploys the reverted commit.
- **Autonomous:** the self-heal medic (`~/.claude/scripts/self-heal.sh`) monitors
  `api.force-ai.co/health`; once this cutover is live, its Railway recovery becomes a true
  rollback-to-last-good instead of redeploy-from-source.

## Rollback of the cutover itself

Re-enable "Deploy on push" in Railway and the GitHub App resumes deploying; the Actions
workflow no-ops again once `RAILWAY_TOKEN` is removed. Fully reversible.
