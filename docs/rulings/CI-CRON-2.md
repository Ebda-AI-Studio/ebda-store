# CI-CRON-2

> Section: 2026-10-03 — Sentry backlog batch (branch `fix/followups13`, issues 2469–2473)

## Ruling CI-CRON-2 — the ~2,500 min/month estimate covers the crons only (issue 2458, 2026-10-03)

Decision: restate the CI-CRON-1 evidence rather than change it. The ~2,500 min/month figure counts the scheduled jobs alone; with `USE_SELF_HOSTED=false`, every push/PR/dispatch run (the full `ci.yml` matrix and the six `cf-deploy.yml` jobs) also bills cloud minutes and is NOT in that figure. `docs/migration/cloudflare-ci-deploy.md` now says so and no longer tells a reader to set `USE_SELF_HOSTED=true`.
Evidence: `cf-deploy.yml` is not schedule-triggered, so its `runs-on` lines stay on the plain `USE_SELF_HOSTED` form and follow the variable to cloud. The push/PR minutes were not measured in this change; read them from the org billing page before relying on any total.
Cost if wrong: the monthly total is understated by an unmeasured amount, and a reader who still follows the old "must stay `true`" line moves every push/PR job back onto the two-runner Umbra pool.
