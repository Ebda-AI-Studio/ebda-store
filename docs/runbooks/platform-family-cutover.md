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

| `payments` | instapay_receipts, manual_payment_claims | N-10d, MONEY; run AFTER `billing` (the script and the router refuse otherwise). Order receipts of DO stores are not copied: pass `--accept-skipped-do-receipts <count the dry run prints>` |
| `ops` | answer_engine_provider_configs, store_usage_snapshots, ci_insights, onesignal_subscriptions | N-10d (+ onesignal_subscriptions, NZ-C-11: apply D1 migration `0006_onesignal_subscriptions.sql` first; if the `ops` marker is ALREADY set, copy this table by hand before relying on it, it reads empty until then); no money coupling |
| `audit` | Postgres `audit_logs` rows with no store -> D1 `platform_audit_log` | N-10d; NEVER refuses a write: the freeze only redirects new store-less rows to D1 (see below) |

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

- **Deferred webhooks with no marker (Ruling NZ-PG-6).** `processDeferredBillingWebhooks` applies nothing until `platform_cutover.billing` exists. If a `--commit` run aborts (no marker) and is not re-run, the webhooks stored during its freeze stay `deferred`: the gateway was answered 200, so it will not retry, and the payment is not booked. The `*/15` cron job `billing-deferred-webhooks` raises a P1 (`billing.deferred_webhooks_orphaned`, at most once per 6 hours per isolate) when deferred rows older than 30 minutes exist and the marker does not. Response: re-run `--commit` (it copies the deferred rows aside and applies them after the flip), or, if the cutover is abandoned, apply them by hand from D1 `billing_webhook_events WHERE outcome = 'deferred'` before touching anything else.
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

## The `audit` family (N-10d)

`--family audit` has its own flow. There is no write freeze: from the moment it starts, new store-less audit rows are written to D1 (the sink reads `platform_freeze.audit` as "new home"), so no audit write is ever refused or lost. It then drains (45 s), copies EVERY Postgres store-less `audit_logs` row into `platform_audit_log` (upsert by id), verifies the rows older than the start instant by count + digest, writes `platform_cutover.audit`, settles, lifts the redirect and re-counts Postgres on a new connection (exit 2 = a write bypassed the sink). Before the flip it also re-imports every Postgres audit row of each DO store into its StoreDO (`POST /cutover/stores/<id>/__auditimport`, the one write a sealed store accepts: INSERT OR IGNORE by id, so a re-run is safe) and verifies per store that the DO holds every row; needs `--do-url` and `CUTOVER_IMPORT_SECRET`. Prod measure 2026-11-04: 48 such rows, all for one store. Stores on their DO write their audit rows to the StoreDO from the deploy of this code (no marker): they were already READ from the DO.

Audit writes that fail are retried through the jobs queue (`audit-write-retry`); a dead letter is parked at R2 `audit-dead-letter/<id>.json` and pages P1. After the flip the audit viewer reads D1 (`GET /admin/audit-logs?storeId=` for one DO store).

## `payments` order of operations

`billing` first (marker present), then `payments`. During the `payments` freeze a claim or receipt write answers the same retryable 503; reads keep working. After the flip a manual payment confirms its claim and approves its receipt in D1 after the ledger row (idempotent on the event id).

After the `payments` flip the cron `payments-reconcile` (every 15 minutes) repairs half-done manual payments: a submitted receipt without a claim is linked to the claim that holds its reference or rolled back to draft; a pending claim whose payment is already in the ledger is confirmed and its receipt approved. Anything else (for example a confirmed claim with no ledger event) pages P1 and is left untouched.

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

## Platform and billing routes with Postgres dead (Rulings NZ-PR-1..4)

- NZ-PR-1 - `withStore`/`withUser`/`userContext` open a per-query lazy scope (no Postgres transaction) when the store is on a DO
  or the platform D1 is bound; an unknown store id stays lazy so the handler answers 404 STORE_NOT_FOUND. Cost if wrong: a
  handler that needs a real RLS transaction on a PG store would run without GUCs; PG stores keep the old transaction path.
- NZ-PR-2 - `store` reads that name only D1-mirrored columns are answered from D1 when the access family is cut over.
  Cost if wrong: a column missing from `D1_FIELDS` silently falls through to Postgres (the sweep catches it).
- NZ-PR-3 - `asPlatformOperator` and `requireMfaEnrolled` verify the super_admin through the ACCOUNTS identity service, not
  `ebda_is_super_admin()`. Cost if wrong: an identity outage denies admin routes (fail closed).
- NZ-PR-4 - the tax review queue fans out over DO stores (500 max, 8 concurrent) as an interim until tax profiles move.
  Cost if wrong: queue is bounded and may omit stores beyond 500.
- NZ-PR-5 (Ruling NEON-ZERO-2) - `PaymentConfig`, `StoreTaxProfile` and `StoreTaxDocument` are per-store config and live in the
  StoreDO (tables `payment_configs`, `store_tax_profiles`, `store_tax_documents` already exist in the DO schema and are copied
  and verified by `migrate-store-to-do` / `verify-store`, which are manifest-driven: per-store freeze -> copy -> verify -> flip,
  no new copy step). Every reader and writer goes through `storeDb` / `storeWriter` (checkout payment.routes + COD fee, MCP order
  tool, InstaPay config, provider health/verification/activation, onboarding, payment-settings, tax-verification, order tax).
  Credentials stay ciphertext written by the route (AES-GCM via `encryption.service`); the DO RPC never logs row data. Default
  unset + create/update is one atomic `$transaction` batch. There is no Postgres fallback for a DO store. Store creation on the
  Postgres path (provisioning.service, a store not yet flipped) still seeds its COD row in Postgres by design; a DO-created store
  seeds it in the DO (`rpc/settings.ts`). BEFORE deploying this change, re-run `migrate-store-to-do` for any store ALREADY flipped
  (it is idempotent per page): edits made to these three tables while the code still wrote Postgres are not in its DO.
  Cost if wrong: a store flipped before the re-copy would show its checkout the older gateway settings until re-copied.
- The review state machine for the tax profile (approve only from pending, revoke only from verified) stays in
  `TaxProfileService.review`; the Postgres trigger `tax_profile_review_guard` has no DO twin, the route (`authorize('super_admin')`
  - MFA) is the only caller. Cost if wrong: a future second caller of `review` would not be refused at the data layer.
- Residual: none for these routes.

## `STORE_CREATE_ON_DO` is a separate step (Ruling NZ-PG-9)

The code deploy does NOT set `STORE_CREATE_ON_DO`. Set it to `"1"` in `apps/api/wrangler.jsonc` and deploy only AFTER every platform-family copy has finished (a store created on the DO inside a copy window could be removed by the copy's "delete D1 rows Postgres lacks" step). Once all `platform_cutover.*` markers exist and the Worker has no Hyperdrive, an unset value shows as `store_create: "misconfigured"` on `GET /health` and pages P1 `api.store_create_on_do_unset`.
