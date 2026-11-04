# Platform table family cutover (Postgres -> D1)

NEON-ZERO-1 item N-10. Run by the CONTROLLER (this repo never holds production credentials). Plan: `docs/plans/2026-11-02-neon-zero.md`
(N-10, Rulings NZ-10-1..4). First family: `billing` = `plans`, `store_subscriptions`, `billing_events`, `billing_grants`,
`billing_referrals`, `billing_reminders`, `billing_webhook_events`, `store_lifecycle_emails`.

## How the switch works

The API (`apps/api/src/services/platform/{cutover,router}.ts`) answers every `prisma.<billing model>.*` call from D1 when D1
`system_settings` has the row `platform_cutover.billing`, and from Postgres otherwise. Deploying the code changes nothing;
the script writes the row. There is never a dual read.

## Preconditions

1. The code is deployed (`curl /health` commit equals the tip of `main`; check every pipeline the merge triggers).
2. D1 schema applied: `wrangler d1 migrations apply ebda-platform --remote -c apps/api/wrangler.jsonc`.
3. D1 `stores` already holds every store (the directory reconcile ran). The script's FK pre-check fails otherwise and lists the stores.
4. Pick a quiet minute: the family is FROZEN for about a minute (45 s drain + copy + 12 s settle). Every write to it answers a retryable 503 (provider webhooks retry; the daily billing cycle retries on its next tick). Reads keep working.
5. A fresh Neon dump exists (`com.forceai.neon-backup`) and the D1 backup sweep ran (`STORE_BACKUPS` manifest lists `billing_events`).

## Steps

```
export CUTOVER_PG_URL=...   # read-only role; add --allow-prod-read for a prod URL
F="--family billing --d1 ebda-platform --d1-target remote --d1-config apps/api/wrangler.jsonc"

node scripts/cf/cutover-platform-family.mjs $F            # 1. DRY RUN: counts PG vs D1, FK pre-check, marker state
node scripts/cf/cutover-platform-family.mjs $F --commit   # 2. copy (idempotent upserts) -> verify (count + digest + FK) -> flip
node scripts/cf/cutover-platform-family.mjs $F --status   # 3. marker + D1 counts
```

`--commit` refuses when the marker exists. Order: FREEZE -> wait `--drain-ms` (45 s) -> open the Postgres snapshot -> copy -> verify -> flip -> wait `--settle-ms` (12 s) -> lift the freeze -> re-digest Postgres on a NEW connection. It flips only if EVERY table is equal on both sides; on a mismatch it exits 1, lifts the freeze, leaves the switch untouched and can simply be re-run. Exit code 2 + a table list after the flip means a write still reached Postgres; re-apply those rows in D1 by hand. `--unfreeze` lifts a freeze left behind by a killed run; `--status` shows marker and freeze.

## Verify after the flip (VERIFIED / NOT VERIFIED, both halves)

- `--status` shows `marker: PRESENT`, D1 counts equal the dry-run PG counts.
- A merchant's billing page loads (`/stores/:storeId/billing`) and the super_admin subscriptions list (`/billing/subscriptions` in `admin.routes.ts`) returns rows.
- A trial store: `startSignupTrial` writes a `trialing` row visible in D1 (`SELECT * FROM store_subscriptions WHERE store_id=?`).
- The daily billing cycle ran once (Cloudflare cron list shows the tick) and `sweepStuckCharges` found nothing it could not resolve.
- NOT verifiable here: a real card renewal (needs the gateway) - watch the first renewal after the flip.

## Rollback

Only before traffic: `--delete-marker`. Isolates that already saw the marker keep serving D1 until they recycle, and rows written
to D1 after the flip are not in Postgres. After real traffic the answer is forward-fix, not rollback.

## What changed for code that touched these tables

- Scripts or consoles that read or write `store_subscriptions` / `billing_*` / `plans` in Postgres after the flip read stale data. Use D1.
- No row-level security on these tables after the flip (Ruling NZ-10-4): every query keeps its `storeId` filter.
- The Neon dump keeps a frozen copy of these tables; D1 export + Time Travel (backup sweep) is the live backup.

## Family `access` (store membership: `store_staff`, `staff_invites`)

Same script, `--family access` (Rulings NZ-A1, NZ-A5, NZ-A6). Differences:

- **Freeze.** The generic freeze/drain/settle of the script applies (`--drain-ms`, `--settle-ms`): every Postgres WRITE of `storeStaff` /
  `staffInvite` (add/remove staff, invite, accept, revoke) answers 503 `PLATFORM_FAMILY_FROZEN` until the script lifts it. The API ignores a freeze
  older than 10 minutes (P1 alert); the script refuses to flip after `--max-freeze-ms` (8 min). `--unfreeze` removes a left-over one.
- **Directory check.** Before anything is written the script compares D1 `stores` with Postgres for every PG-backed store (owner, status, billing
  suspension, deleted) and refuses on a difference or a missing store: the gate decides on those D1 columns after the flip. Fix with the directory
  reconcile and re-run. DO stores (D1 `storage_backend = 'do'`) are skipped; the column exists only in D1.
- **Strays.** D1 rows that Postgres does not have are deleted inside the freeze (reported per table).
- **Fail closed.** After the flip, the drift check and the settle wait, the copied Postgres rows are DELETED (by primary key, one transaction) so every
  Postgres policy/definer that still reads `store_staff` denies. Needs a write URL: `--pg-write-url` (or `CUTOVER_PG_WRITE_URL`), plus
  `--allow-prod-write` for a Neon host; a dry run and `--commit` without it refuse before freezing anything. The Neon dump (`com.forceai.neon-backup`)
  must be fresh. Skipped on drift (those rows are the only copy of a write D1 lacks); exit code 3 if the emptying itself failed.
- **After the flip** the gate (`requireStoreAccess`, `checkStoreAccess`), staff routes, invite accept, `storesForUser`, `ownedStoreIds`, merchant-MCP
  membership, the staff seat count, `GET /admin/stores` (staff) and the payment timeline read D1 only. Verify (VERIFIED / NOT VERIFIED): owner 200
  and another owner 403 on `/stores/:id/products`; add a staff member, then that user's GET is 200; remove them, the very next GET is 403 and
  `GET /payments/:id/events` is 404 for them; accept a fresh invitation; `SELECT count(*) FROM store_staff` in D1 equals the dry-run PG count and
  Postgres `store_staff` is empty. NOT verifiable until the request transaction is lazy: an admin GET with Postgres stopped.
- Rollback: only before traffic (`--delete-marker`); the emptied Postgres rows come back from the dump.
