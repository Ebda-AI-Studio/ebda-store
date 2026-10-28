# INNGEST-SYNC-1

> Section: Lifecycle emails and referral attribution (2026-10-22, branch `feat/lifecycle-emails`)

Ruling INNGEST-SYNC-1 (2026-10-23) — `cf-api-deploy.yml` re-syncs Inngest (`PUT /api/v1/inngest`, 3 tries, job fails unless "Successfully registered") after every API deploy. Evidence: the gold-rate feed cron (#151) never ran in prod (`gold_rates` held only the 3 seed rows 12 h later); a manual PUT answered `"modified": true`. Guard: `tests/unit/workflow-inngest-sync-after-deploy.test.ts` (red without the step). Cost if wrong: a deploy fails on an Inngest outage; re-run the job. SUPERSEDED by G5-3: the step is gone with Inngest.
