# CF-MIGRATE-1

> Section: 2026-10-07 — INFRA-GAPS (branch `fix/infra-gaps`)

Ruling CF-MIGRATE-1 — FIXED: `cf-api-deploy.yml` deployed the Worker without ever running migrations (`20261007000000_locked_pricing` was applied by hand). A `prisma migrate deploy` step now runs BEFORE `wrangler deploy` with `secrets.EBDA_MIGRATE_DATABASE_URL` (Neon owner, direct host) as `DATABASE_URL` and `DIRECT_URL`; a failure fails the job, so no deploy follows. Not yet exercised: the workflow is `workflow_dispatch` on main only, so the first real proof is the next dispatch. Cost if wrong: a migration that is not backward compatible with the still-running old Worker breaks it for the seconds between migrate and deploy; migrations must stay expand-then-contract.
