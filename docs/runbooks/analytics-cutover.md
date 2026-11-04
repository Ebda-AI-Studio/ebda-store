# Per-store analytics to the StoreDO, AiUsage to D1

NEON-ZERO-1 (Ruling NZ-AN-1). Run by the CONTROLLER (this repo never holds production credentials). Plan: `docs/plans/2026-11-02-neon-zero.md` (N-11, N-13).

Two moves, independent, either order:

| Move                              | Tables                                                                                                 | Switch                                            | Script                                                                                                                          |
| --------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| A. AI usage to D1                 | `ai_usage`                                                                                             | D1 `system_settings` `platform_cutover.ai-usage`  | `scripts/cf/cutover-platform-family.mjs --family ai-usage` (same flags and steps as `docs/runbooks/platform-family-cutover.md`) |
| B. Per-store analytics to each DO | `search_query_daily`, `product_daily_views`, `qr_scan_daily`, `notification_logs`, `gsc_daily_metrics` | D1 `system_settings` `platform_cutover.analytics` | `scripts/cf/copy-analytics-to-do.mjs`                                                                                           |

Deploying the code moves nothing: until a marker exists every store, DO or not, reads and writes these tables exactly as before.

## Preconditions

1. The code is deployed (`curl https://api.ebda.app/health` commit equals the tip of `main`; check every pipeline the merge triggered). The Worker applies `cf-0003_analytics` to each StoreDO on its next request (no action).
2. D1 schema: `wrangler d1 migrations apply ebda-platform --remote -c apps/api/wrangler.jsonc` (adds `ai_usage`, migration `0003_ai_usage.sql`). Move A needs every store in D1 `stores` (the script's foreign-key pre-check lists the missing ones).
3. A quiet minute: each move freezes its family for about a minute. Move B refuses a DO store's analytics WRITES with a retryable 503 (search/view/QR counters swallow it; notification and GSC writers retry); reads keep going to Postgres. Move A refuses AI-usage writes the same way.
4. A fresh Neon dump exists.

## Move B steps

```
export CUTOVER_PG_URL=...  CUTOVER_IMPORT_SECRET=...   # read-only role; the bearer of /cutover/*
F="--d1 ebda-platform --d1-target remote --d1-config apps/api/wrangler.jsonc --do-url https://api.ebda.app --allow-prod-read"

node scripts/cf/copy-analytics-to-do.mjs $F            # 1. DRY RUN: per DO store, Postgres rows per table vs the DO's state; native rows are flagged
node scripts/cf/copy-analytics-to-do.mjs $F --commit   # 2. freeze, drain, copy, DO-side exact verify, marker, settle, thaw, re-count Postgres
node scripts/cf/copy-analytics-to-do.mjs $F --status   # 3. marker + per-store DO row counts
```

`--commit` refuses when the marker exists. A failed or killed run leaves NO marker; `--unfreeze` lifts a freeze left behind; re-running resumes (a batch whose id the DO ledger holds is a no-op, so nothing is counted twice). The DO writes its done-marker only when its row count and the SUM of every counter column equal what Postgres held; after that it refuses every further batch. The script sets the D1 marker only if EVERY store finished. Exit code 2 after the marker means a write still reached Postgres: the printed list is what to re-apply in that DO by hand.

## Verify after the flip (VERIFIED / NOT VERIFIED, both halves)

- `--status` shows `marker: PRESENT` and `done=true` for every store; DO counts equal the dry-run Postgres counts.
- Admin: a DO store's `/stores/:id/notifications` log and `/search-insights` render the copied rows; `GET /stores/:id/qr/stats` totals match.
- A storefront search and a product page view add one count in the DO (`--status` row counts move by one), none in Postgres.
- The nightly cron `search-log-purge-daily` and `gsc-ingest-cron` ran for a DO store without a Postgres connection (Cloudflare logs, no `[SEARCH-LOG] purge failed`).
- NOT verifiable here: a real GSC ingest needs the service account; watch the next 04:00 UTC run.

## After both moves

`node scripts/cf/not-on-do.mjs` must exit 0 and `docs/cf/not-on-do.json` stays empty. Only then set `JOBS_ON_DO=1` (runbook step 8.3 of `docs/runbooks/cutover-cf.md`).

## Rollback

Only before traffic: `--delete-marker`. After real traffic the answer is forward-fix: rows written to the DO after the flip are not in Postgres.
