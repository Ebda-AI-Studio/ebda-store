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
4. Low traffic: writes that land in Postgres during the last seconds before the flip are lost (see step 4).
5. A fresh Neon dump exists (`com.forceai.neon-backup`) and the D1 backup sweep ran (`STORE_BACKUPS` manifest lists `billing_events`).

## Steps

```
export CUTOVER_PG_URL=...   # read-only role; add --allow-prod-read for a prod URL
F="--family billing --d1 ebda-platform --d1-target remote --d1-config apps/api/wrangler.jsonc"

node scripts/cf/cutover-platform-family.mjs $F            # 1. DRY RUN: counts PG vs D1, FK pre-check, marker state
node scripts/cf/cutover-platform-family.mjs $F --commit   # 2. copy (idempotent upserts) -> verify (count + digest + FK) -> flip
node scripts/cf/cutover-platform-family.mjs $F --status   # 3. marker + D1 counts
```

`--commit` refuses when the marker exists. It flips only if EVERY table is equal on both sides; on a mismatch it exits 1 with
the switch untouched and can simply be re-run. After the flip it re-digests Postgres: exit code 2 + a table list means a
Postgres write landed in the flip window; re-apply those rows in D1 by hand (query Postgres on `updated_at`).

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

Same script, `--family access`. Differences (Rulings NZ-A1, NZ-A2):

- **Freeze.** `--commit` writes `system_settings.platform_freeze.access` first: every Postgres WRITE of `storeStaff` / `staffInvite` (add/remove
  staff, invite, accept, revoke) answers 503 `PLATFORM_FAMILY_FROZEN` until the script lifts it; reads and the access gate keep working from
  Postgres. The script waits `--freeze-wait-ms` (default 20000, longer than the 5 s freeze cache and the 10 s cutover cache), only then opens
  its snapshot, copies, verifies, flips, waits again, re-digests on a NEW connection and lifts the freeze. `--unfreeze` removes a left-over one.
- **Directory check.** Before anything is written the script compares D1 `stores` with Postgres for every PG-backed store (owner, status,
  billing suspension, deleted) and refuses on a difference or a missing store: the gate decides on those D1 columns after the flip. Fix with the
  directory reconcile (`reconcileStoreDirectory`) and re-run. DO stores are skipped (their Postgres row is sealed).
- **After the flip** the gate (`requireStoreAccess`, `checkStoreAccess`), staff routes, invite accept, `storesForUser` (token `stores[]`),
  `ownedStoreIds`, merchant-MCP membership and the staff seat count read D1 only. Verify (VERIFIED / NOT VERIFIED): owner 200 and another
  owner 403 on `/stores/:id/products`; add a staff member, then that user's GET is 200; remove them, the very next GET is 403; accept a fresh
  invitation; `SELECT count(*) FROM store_staff` in D1 equals the dry-run PG count. NOT verifiable until the request transaction is lazy: an
  admin GET with Postgres stopped (see the plan, N-6 evidence).
- Rollback: only before traffic (`--delete-marker`).
