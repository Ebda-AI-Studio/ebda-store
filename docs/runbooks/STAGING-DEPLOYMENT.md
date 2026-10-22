# Staging deployment + promotion flow

> **SUPERSEDED (2026-07).** This runbook describes the Vercel-dashboard-based staging
> flow from 2026-05-27. The frontends (`apps/web`, `apps/admin`, `apps/orders`) have
> since fully migrated off Vercel to Cloudflare Workers (`cf-deploy.yml`, deploys on
> every push to `main` — see `docs/DEPLOYMENT.md`). Per `docs/DEPLOYMENT.md`
> ("Environments & staging posture", current as of 2026-07-10), **there is no
> separate staging Railway/Cloudflare environment today** — PR previews are
> non-functional-by-default instead. Treat everything below as historical context
> for the reasoning, not as the current deploy procedure.

> Status: **LIVE since 2026-05-27 afternoon.** Ahmad completed the Railway +
> Vercel dashboard flips; staging now tracks the `staging` branch and prod
> tracks `main`. All work goes feature → staging → main via PR promotion.

## Why this exists

Before 2026-05-27 every push to `main` triggered **both** Vercel projects
(prod + staging) and **both** Railway envs (prod + staging) at the same time.
That made "staging" theatrical: the same SHA went live for paying merchants
the same moment it went live for "test" — staging gave no validation window.

Costs that were already paid:

- Burst-pushed 30+ commits over 2 days → ~60+ workflow runs → ~600 min CI used
- Staging Railway env ran 24/7 for weeks with no real traffic
- Auto-fix cascade kept stacking PRs onto main without convergence
- 2 days of red CI never closed by ONE focused stabilization PR

This runbook fixes the deployment topology to use `staging` as a real gate.

## 1. Branch model

```
feature/*  ──PR──▶  staging  ──PR──▶  main
              ▲             ▲           ▲
              │             │           └── prod Vercel + prod Railway auto-deploy
              │             └── staging Vercel + staging Railway auto-deploy
              └── PR validation CI gates (lint + typecheck + unit + build)
```

- **`main`** = production. Only merges from `staging` (or hotfix PRs).
- **`staging`** = integration branch. All feature PRs target here.
- **`feature/*`** = branches off `staging`, never off `main`.

### Hotfix exception

When production is down (P0 incident):

1. Fix on a `hotfix/*` branch off `main` (not staging).
2. Push directly to `main` with explicit "hotfix" commit message.
3. **Same commit batch**: cherry-pick the hotfix back to `staging` so the
   two branches stay aligned.

Example: 2026-05-27 sharp linuxmusl crash (commit `e2024c9a`).

## 2. CI workflow gating

| Workflow                           | Trigger                                        | Purpose                                                      |
| ---------------------------------- | ---------------------------------------------- | ------------------------------------------------------------ |
| `pr-validation.yml` (if present)   | PRs to `staging` or `main`                     | Pre-merge gates: lint + typecheck + unit + build             |
| `ci.yml` / `production-deploy.yml` | Push to `main`                                 | Full suite + post-deploy health check                        |
| `staging-validation.yml` (new)     | Push to `staging`                              | Same suite as prod — staging must pass everything prod would |
| `neon-snapshot.yml`                | Push to `main`                                 | Per-commit `prod-<sha>` snapshot branch on Neon              |
| `gitleaks.yml`                     | Push to any branch                             | Secret scan                                                  |
| `load-test-nightly.yml`            | `workflow_dispatch` only (disabled 2026-05-27) | Manual k6 — used to fire nightly with 0 merchant traffic     |

## 3. **Ahmad's dashboard flips** (one-time, ~10 min)

These can't be code changes — they live in Vercel + Railway dashboards.

### Vercel — `force-web` project

1. Open https://vercel.com/ahmed0montaser/force-web/settings/git
2. **Production Branch**: stays `main`.
3. **Preview deployments**: by default Vercel previews EVERY branch, including `staging`. That gives you a preview URL per staging commit — no extra config needed.
4. **Domain attachment**: production domain (`demo-merchant.com`) stays on the Production Branch (`main`). Add a staging-specific preview alias (e.g. `staging.demo-merchant.com`) via Domains → Add Domain → assign to `staging` branch.

### Vercel — `force-admin` project

Same as `force-web`. Production Branch stays `main`. Optionally add `staging.store.ebda.app`.

### Railway — API service

1. Open the API service → Settings → "Deployment Triggers".
2. Production env: source branch = `main` (already correct).
3. Staging env: source branch should be **`staging`** (currently `main` — flip this).
4. Save. Railway will not redeploy immediately; the next push to `staging` will trigger the staging env build.

### Verify the flip

After flipping Railway:

```bash
# Push a no-op commit to staging to confirm only the staging env builds
cd ~/Desktop/projects/ebda-store
git checkout staging
git commit --allow-empty -m "chore: verify staging gate"
git push origin staging
```

Watch Railway: ONLY the staging env should build. Prod env should stay quiet.
Watch Vercel: a preview build kicks off, prod stays quiet.

## 4. Daily promotion flow

```bash
# 1. Start a feature branch off staging
git checkout staging
git pull
git checkout -b feature/some-thing

# 2. ...do work, commit, push, open PR targeting staging...

# 3. After PR merge, staging redeploys to staging env. Smoke-test it.

# 4. When staging is green + smoke-tested, open promotion PR
git checkout staging
git pull
gh pr create --base main --head staging \
  --title "promote: staging → main (week N)" \
  --body "Includes:\n- feature/some-thing (PR #N)\n- ..."

# 5. Review + merge. Prod redeploys.
```

## 5. Rollback paths

### Rollback prod only

```bash
bash scripts/rollback.sh  # git revert + push to main
```

### Rollback staging only

```bash
git checkout staging
git revert <bad-sha>
git push origin staging
```

### Roll a feature back from staging (before promotion)

```bash
git checkout staging
git revert <bad-sha>
git push origin staging
# the promotion PR will then drop that commit on next iteration
```

## 6. Anti-patterns to refuse

- **Pushing feature work directly to `main`.** Always staging first. Hotfix is the only exception and must be explicit.
- **Auto-merging promotion PRs.** Promotion to `main` is a human decision — eye on Railway + Vercel during the rollout.
- **Subagents pushing per-task.** Batch all commits into ONE push at the end of a multi-task feature, not per-task. Wave 1+2 of the WhatsApp native catalog spec burst-pushed 60+ runs across 2 days.
- **Letting staging diverge from main.** After every prod release, `git pull origin main` into staging immediately so staging is always main + WIP.
- **Re-enabling auto-fix without a circuit breaker.** Auto-fix cascade in 2026-05-26 stacked PRs without convergence. Don't re-enable without max-PR-per-day cap.

## 7. Monitoring + alerts

- **Prod health**: `production-deploy.yml` includes a post-deploy `health-check` job; failure pages Telegram.
- **Staging health**: same job to be added to `staging-validation.yml`.
- **Cost**: GitHub Actions monthly minutes — check `gh api /repos/Whisky-11/<repo>/actions/billing` if usage looks high.

## 8. Related runbooks

- [ROLLBACK.md](../ROLLBACK.md) — code + DB rollback procedures
- [DEPLOYMENT.md](../DEPLOYMENT.md) — env vars, secrets, infra inventory

## 9. Open items (Ahmad to decide)

- [ ] Should `staging-validation.yml` include the FULL E2E + integration suite (slower, ~20min) or a subset (~10min)?
- [ ] Add `staging.demo-merchant.com` + `staging.store.ebda.app` DNS records?
- [ ] Document staging-DB swap policy: same Neon DB as prod, or staging-only Neon branch? Currently same.
