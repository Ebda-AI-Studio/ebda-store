# Platform table family cutover (Postgres -> D1)

NEON-ZERO-1 item N-10. Run by the CONTROLLER (this repo never holds production credentials). Plan: `docs/plans/2026-11-02-neon-zero.md`
(N-10, Rulings NZ-10-1..4). First family: `billing` = `plans`, `store_subscriptions`, `billing_events`, `billing_grants`,
`billing_referrals`, `billing_reminders`, `billing_webhook_events`, `store_lifecycle_emails`.

## Families and the order to run them

| family     | tables                                                                                                                                                                                                               | notes                                                                  |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `billing`  | plans, store_subscriptions, billing_events, billing_grants, billing_referrals, billing_reminders, billing_webhook_events, store_lifecycle_emails                                                                     | N-10a; webhooks deferred during the freeze                             |
| `platform` | system_settings, store_features, legal_acceptances, legal_notice_sends, legal_notice_deliveries, provider_verifications, provider_verification_events, provider_activation_requests, merchant_api_keys, SlugRedirect | N-10b; run AFTER `billing` (system_settings carries the markers)       |
| `inbox`    | webhook_events                                                                                                                                                                                                       | N-10b; callbacks are recorded into D1 during the freeze, never refused |

Each family: `node scripts/cf/cutover-platform-family.mjs --family <name> --d1 ebda-platform --d1-target remote --d1-config apps/api/wrangler.jsonc --pg-url "$CUTOVER_PG_URL"` (dry run), then the same plus `--commit`. One family at a time; `--status` shows marker and freeze.

## How the switch works

The API (`apps/api/src/services/platform/{cutover,router}.ts`) answers every `prisma.<billing model>.*` call from D1 when D1
`system_settings` has the row `platform_cutover.billing`, and from Postgres otherwise. Deploying the code changes nothing;
the script writes the row. There is never a dual read.

## Preconditions

1. The code is deployed (`curl /health` commit equals the tip of `main`; check every pipeline the merge triggers).
2. D1 schema applied: `wrangler d1 migrations apply ebda-platform --remote -c apps/api/wrangler.jsonc`.
3. D1 `stores` already holds every store (the directory reconcile ran). The script's FK pre-check fails otherwise and lists the stores.
4. Pick a quiet minute: the family is FROZEN for about a minute (45 s drain + copy + 12 s settle). Every write to it answers a retryable 503 (provider webhooks retry; the daily billing cycle retries on its next tick). Reads keep working.
5. A fresh Neon dump exists and the D1 backup sweep ran (`STORE_BACKUPS` manifest lists `billing_events`).

## Steps

```
export CUTOVER_PG_URL=...   # read-only role; add --allow-prod-read for a prod URL
F="--family billing --d1 ebda-platform --d1-target remote --d1-config apps/api/wrangler.jsonc"

node scripts/cf/cutover-platform-family.mjs $F            # 1. DRY RUN: counts PG vs D1, FK pre-check, marker state
node scripts/cf/cutover-platform-family.mjs $F --commit   # 2. copy (idempotent upserts) -> verify (count + digest + FK) -> flip
node scripts/cf/cutover-platform-family.mjs $F --status   # 3. marker + D1 counts
```

`--commit` refuses when the marker exists. Order: FREEZE -> wait `--drain-ms` (45 s) -> open the Postgres snapshot -> copy -> verify -> flip -> wait `--settle-ms` (12 s) -> lift the freeze -> re-digest Postgres on a NEW connection. It flips only if EVERY table is equal on both sides; on a mismatch it exits 1, lifts the freeze, leaves the switch untouched and can simply be re-run. Exit code 2 + a table list after the flip means a write still reached Postgres; re-apply those rows in D1 by hand. `--unfreeze` lifts a freeze left behind by a killed run; `--status` shows marker and freeze.

## What the freeze does to callers (about a minute)

- Every write answers `503 PLATFORM_FAMILY_FROZEN` with `details.retryable`, `retryAfterSeconds: 30` and `details.messageAr` (the admin UI shows it). Reads keep working.
- Billing webhooks are NOT refused: Paymob documents no retry for a failed delivery and Kashier's is unverified, so a 503 could lose a payment notification. The webhook is authenticated first (signature / HMAC; a bad one is rejected and stored nowhere), then stored durably as `billing_webhook_events.outcome = 'deferred'` (idempotent on provider + event id) and answered 200 `{ outcome: 'deferred' }`. Once the freeze is lifted the queue is applied exactly once (confirm-before-apply runs then): by the first webhook after the freeze, by the `*/15` cron job `billing-deferred-webhooks`, and by the daily billing cycle. A live redelivery that wins the race takes the deferred row over (one flip `deferred -> processing`); a failed apply puts the row back. `sweepStuckCharges` still asks the gateway about renewals pending over an hour. The copy script sets deferred rows aside during the copy and puts back the ones Postgres does not already know.
- The freeze row carries `expiresAt` (`--freeze-ttl-ms`, default 15 min). If the script dies without lifting it the API IGNORES it after that and pages (P1); SIGINT/SIGTERM lift it; a failed lift is loud and exits non-zero (`--unfreeze` removes it).

## Secrets in the cutover

- Deferred billing webhooks are stored with the raw body DROPPED and the parsed event (card token included) ENCRYPTED with the app's encryption key; `detail` is set to NULL the moment the event is applied.
- Rows the script sets aside are written to `.cutover-stash/<family>-<time>.ndjson` BEFORE they are deleted: AES-256-GCM per line with the key in `CUTOVER_STASH_KEY` (>= 32 chars; the run refuses to set rows aside without it), mode 0600, deleted once the rows are back in D1. If a run dies, `--restore-stash <file>` puts them back (same key, same `--d1` flags).

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

- **Freeze.** The generic freeze/drain/settle of the script applies (`--drain-ms`, `--settle-ms`, `--freeze-ttl-ms`): every WRITE of `storeStaff` /
  `staffInvite` (add/remove staff, invite, accept, revoke) answers 503 `PLATFORM_FAMILY_FROZEN` until the script lifts it. The freeze expires
  (`expiresAt`, P1 alert); the script refuses to flip after 80% of the TTL. `--unfreeze` removes a left-over one.
- **Directory check.** Before anything is written the script compares D1 `stores` with Postgres for every PG-backed store (owner, status, billing
  suspension, deleted) and refuses on a difference or a missing store: the gate decides on those D1 columns after the flip. Fix with the directory
  reconcile and re-run. DO stores (D1 `storage_backend = 'do'`) are skipped; the column exists only in D1.
- **Strays.** D1 rows that Postgres does not have are deleted inside the freeze (reported per table).
- **Fail closed.** After the flip, the drift check and the settle wait, the copied Postgres rows are DELETED (by primary key, one transaction) so every
  Postgres policy/definer that still reads `store_staff` denies. Needs a write URL: `--pg-write-url` (or `CUTOVER_PG_WRITE_URL`), plus
  `--allow-prod-write` for a Neon host; a dry run and `--commit` without it refuse before freezing anything. The Neon dump
  must be fresh. Skipped on drift (those rows are the only copy of a write D1 lacks); exit code 3 if the emptying itself failed.
- **After the flip** the gate (`requireStoreAccess`, `checkStoreAccess`), staff routes, invite accept, `storesForUser`, `ownedStoreIds`, merchant-MCP
  membership, the staff seat count, `GET /admin/stores` (staff) and the payment timeline read D1 only. Verify (VERIFIED / NOT VERIFIED): owner 200
  and another owner 403 on `/stores/:id/products`; add a staff member, then that user's GET is 200; remove them, the very next GET is 403 and
  `GET /payments/:id/events` is 404 for them; accept a fresh invitation; `SELECT count(*) FROM store_staff` in D1 equals the dry-run PG count and
  Postgres `store_staff` is empty. NOT verifiable until the request transaction is lazy: an admin GET with Postgres stopped.
- Rollback: only before traffic (`--delete-marker`); the emptied Postgres rows come back from the dump.
