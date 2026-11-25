# Runbook: closed-store purge (Ruling NZ-D15B)

The `closed-store-purge` job (daily 02:17 UTC) physically removes a CLOSED store's Durable Object after the legal retention period.
The wipe is irreversible. This runbook is what to do before the first live run, when it alerts, and what protects the archive.

## Before the first live run (do not skip)

1. Read at least two weeks of dry-run output: Worker logs `[closed-store-purge] run` (`live: false`, a `tally`) and every `DRY RUN: would wipe` line. Each would-be wipe lists the store id, the archive key and the row count.
2. Spot-check one `dry_run_verified` store by hand: fetch `closed-store-archive/<store>/fiscal-<closedAt>.ndjson` from the private bucket, count lines, compare with the store's fiscal row count.
3. Apply the R2 retention lock below. Confirm with counsel the 5 vs 7 year period and the notice wording.
4. Only then set `CLOSED_STORE_PURGE_LIVE=true` in `apps/api/wrangler.jsonc` vars (a dashboard var is wiped by the next deploy). It stays a dry run until 2026-12-24 whatever the flag says. To stop: remove the var and deploy.

## What the purge deletes besides the Durable Object (Ruling D15B-LIVE-GATE follow-up)

- The payment-proof FILES: every `instapay_receipts.storage_key` object whose `image_deleted_at` is not set (private bucket) and any legacy `manual_payment_claims.proof_url` object of the store's own prefix, deleted BEFORE the tombstone clears the pointers (`lib/store-proof-files.ts`). A failed delete aborts with a P1 and the tombstone does not run; the next run retries. Production check 2026-11-24 (read-only): 5 InstaPay receipts, all images still stored, so without this step the screenshots (payer name, account, mobile) would have outlived the purge; 1 manual claim, 0 proof URLs.
- The kept tables lose personal columns in the tombstone; `packages/cf-schema/test/erasure-classification.test.ts` fails CI when any column of a store-keyed kept table is neither classified personal nor reviewed as not personal.

## What the job keeps for ever (not purged)

- The `stores` row stays as a TOMBSTONE (slug `~purged~<id>`, name `[purged]`, domain / logo / contact columns NULL, soft-deleted). Ebda's own billing_events, instapay_receipts, manual_payment_claims, billing_reminders, store_subscriptions, trust_requests and ai_usage reference `stores(id)` ON DELETE CASCADE, so the row is never deleted (`lib/store-tombstone.ts`).
- The archive `closed-store-archive/<store>/fiscal-<closedAt>.ndjson` and the per-closure ledger `closed-store-purge/<store>/ledger-<closedAt>.json` in the private bucket.
- The 7-year clock counts the later of the last fiscal document and the last billing_event / instapay_receipt / manual_payment_claim of the store.

## R2 bucket lock on `closed-store-archive/` (NOT applied; needs Ahmad's decision)

The archive is the only copy of a purged store's tax records, so it must not be deletable or overwritable by a bug or a leaked key during the retention period. Recommended (Cloudflare R2 bucket locks, per prefix):

- Rule: bucket `ebda-private` (the private bucket named by `STORAGE_PRIVATE_BUCKET`), prefix `closed-store-archive/`, condition `Age`, retain for 2555 days (7 years) from object creation (use 2920 days if counsel says add the 2-year buffer after the last document).
- Not on `closed-store-purge/` (the ledger is rewritten during a purge).
- Dashboard: R2 > bucket > Settings > Object lock / Bucket lock rules; or `wrangler r2 bucket lock add ebda-private --name closed-store-archive --prefix closed-store-archive/ --retention-days 2555`. Check the exact wrangler flags with `wrangler r2 bucket lock --help` before running: they are version dependent.
- Effect: the write-once `ifAbsent` put still works for a new archive; any delete or overwrite inside the period is refused by R2. Cost if wrong: a locked object cannot be removed early even if requested (PDPL erasure of fiscal records is not available by law before the period anyway).

## When it alerts

- `Closed-store purge aborted, nothing deleted` (P1): the alert body names the store and the reason. Nothing was deleted at that step.
  - `archive read-back mismatch` / `cannot be read back` / `export has N rows, the store holds M`: the archive is wrong or the store changed. The archive object is write-once, so do NOT delete it blindly: compare it with the store (`closedFiscalPage`), and if the store legitimately changed, delete that closure's archive object AND ledger by hand so the next run exports again.
  - `PURGE_EXPORT_STALE`: the DO's fiscal count differs from the verified export (the store changed after the export). Same remedy.
  - `unexpected failure`: read the Worker log line; the next daily run retries the store.
- A crash between the wipe and the tombstone: the ledger has `wipeStartedAt`; the next run resumes at the wipe (an already-empty Durable Object counts as wiped) and then tombstones the directory row. Nothing to do by hand.

## What was verified and what was not

Verified in tests only (rules through ports, the Durable Object on workerd, the tombstone on the real D1 schema with foreign keys on). The job has never run against production data.
