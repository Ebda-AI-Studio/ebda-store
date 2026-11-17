# PRIVATE-ARCHIVES-1 - audit archives and expense receipts live in the private bucket

Ruling PRIVATE-ARCHIVES-1 (#739 review, 2026-11-17).

1. **No public audit archive ever existed, so nothing is migrated.** The old `audit-log-archive` wrote `audit-archive/*.jsonl` to `STORAGE_BUCKET` (public `ebda-media`) only when the `STORAGE_*` S3 credentials were set. Listing on 2026-11-17 (Cloudflare R2 API, account 69188202, read-only, full pagination):
   - `ebda-media`: 269 objects in total, 0 under `audit-archive/`, 0 keys containing `receipt`, 0 under a `/misc/` folder (the old receipt folder);
   - `ebda-private`: 0 under `audit-archive/`;
   - `ebda-logs`: 0 under `audit-archive/`.

   A copy-then-delete job would therefore move nothing, so none is added. New archives go only to `ebda-private` (`archivePut`, STORE_BACKUPS binding).

2. **Expense receipts are not metered against the plan storage ceiling (residual).** Receipts now go to the PRIVATE bucket, outside the public-uploads usage that `assertStorageRoom` counts. Today a store's receipt uploads are bounded by:
   - the upload rate limiters (`uploadLimiter`, `dailyUploadLimiter`);
   - the 10 MB per-file cap;
   - the 2000 px resize (~95% smaller).

   Metering the private bucket needs its own usage counter, which is not built.

Cost if wrong: (1) none; the listing is the evidence, and a re-list before deploy confirms it. (2) A store could store receipts beyond its plan's storage figure, bounded by the daily upload limit; the R2 cost is ours and small.
