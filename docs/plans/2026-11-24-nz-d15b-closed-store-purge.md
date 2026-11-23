# NZ-D15B: closed-store purge (plan N-24, written first)

Date 2026-11-24. Ruling NZ-D15B (Ahmad 2026-11-24, recommended default approved; proposal in the approvals file). Register row: Neon-zero (N-24).
Counsel has NOT verified 5 vs 7 years or the Egyptian article numbers; the ruling says so. The wipe is IRREVERSIBLE.

## Finish line

- Must work: a closed DO store that is past retention is exported to the private archive, the archive is read back and verified, then the Durable Object is wiped and the store's directory row becomes a TOMBSTONE (never deleted: Ebda's billing records reference it); any mismatch deletes nothing and raises a P1.
- Exercised: the rules through in-memory ports (`tests/unit/closed-store-purge.test.ts`, 15 cases), the Durable Object side on real workerd (`apps/api/workers-do/closed-store-purge.test.ts`, 4 cases: open store refused, paged export, stale export refused, wipe leaves no table), the job registry.
- Must NOT change: the delete flow (close + anonymise keep the store retained), any open store, the fiscal archive view, other jobs.
- Done: the above green, `tsc` api clean. The job has NEVER run against prod data (dry run is the default and the date gate keeps it dry until 2026-12-24).

## Rules (what the code does)

- Due = 7 years (RETENTION_YEARS) after the LATER of the store's last fiscal document and its last platform billing record (billing_events / instapay_receipts / manual_payment_claims); 90 days after closure for a store with neither.
- Notice: the owner is emailed at least 30 days before the wipe; a store with no usable contact (erased owner) is recorded `no_contact` and still waits the 30 days. No notice recorded, no wipe.
- Export is write-once (`closed-store-archive/<store>/fiscal.ndjson`, never replaced) and verified by reading it back: rows and sha256 must equal the manifest, and the rows must equal the store's fiscal count.
- The Durable Object re-checks: closed AND fiscal row count equal to the verified export, else refuses (`PURGE_EXPORT_STALE`).
- Per-store ledger in the private bucket (`closed-store-purge/<store>/ledger.json`): notice time, archive manifest, wiped marker (a wipe whose directory delete failed resumes at that step only).
- DRY RUN by default. Live needs `CLOSED_STORE_PURGE_LIVE=true` AND a date on or after 2026-12-24. Dry run still exports and verifies (idempotent), wipes nothing, logs `dry_run_verified`.
- Any abort or unexpected failure: P1 alert naming the store; one store never stops the next.

## Review fixes (#1109)

- BLOCKER: the directory step no longer hard-deletes `stores`. Platform tables (billing_events = Ebda's own invoices, instapay_receipts, manual_payment_claims, billing_reminders, store_subscriptions, trust_requests, ai_usage) reference it ON DELETE CASCADE. A tombstone row stays (slug `~purged~<id>`, personal columns NULL, soft-deleted); only store_staff, merchant_api_keys, staff_invites and SlugRedirect rows are deleted. `lib/store-tombstone.ts`, proven on the real D1 schema with foreign keys on (including a control showing a plain DELETE cascades).
- Crash mid-wipe: `wipeStartedAt` is written to the ledger before the wipe; a rerun resumes at the wipe, and an already-empty Durable Object counts as wiped (`resume`, refused for any store that still has a profile).
- Archive and ledger are per closure (`fiscal-<closedAt>.ndjson`, `ledger-<closedAt>.json`); a ledger of another closure is ignored.
- Runbook `docs/runbooks/closed-store-purge.md` incl. the R2 retention lock on `closed-store-archive/` (written, NOT applied).

## Changes

1. `apps/api/src/lib/closed-store-purge.ts` (rules + ports), `closed-store-purge-adapters.ts` (D1 directory, StoreDO RPC, private bucket, mailer), job `closed-store-purge` (daily 02:17 UTC).
2. StoreDO: `closedFiscalPage` (read only, closed stores only) and `purgeClosedStore` (the only physical wipe in the code base).
3. `StorageService.putPrivateAt` (explicit key, only the two `closed-store-*` prefixes, `ifAbsent`), `sendClosedStorePurgeNoticeEmail`.
4. Docs: this plan, the ruling, README index, ENVIRONMENT.md, plan N-24 ticked.

## Cost if wrong / rollback

After the DO wipe there is NO rollback. Mitigations: the read-back gate, the stale-count refusal, the dry-run period, the write-once archive that stays in the private bucket (7 years from each document by its bucket rule), the notice. Worst case: an unverified or wrongly-verified export plus a wipe loses a merchant's tax record permanently; too-early purge breaches the retention law; too-late purge only keeps data longer than needed. Roll the feature back by leaving `CLOSED_STORE_PURGE_LIVE` unset (it is unset).

## Not decided here

5 vs 7 years (counsel), whether the 30-day notice is enough, and who owns the email wording; the job's first live run needs the controller to read a full dry-run log first.
