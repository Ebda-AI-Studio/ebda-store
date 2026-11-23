# STORAGE-FAILOPEN-1 - the upload storage ceiling fails open, never silently

Ruling STORAGE-FAILOPEN-1 (controller, 2026-11-17).

- **Decision:** when the R2 usage counter cannot be read, the plan storage gate (`assertStorageRoom` → `storageUsageMb` in `apps/api/src/services/plan-limit.service.ts`) admits the upload as if 0 MB were used.
  - The billing page shows the same failure as "not known right now", never 0 (QA-STOR-1).
  - Every fail-open writes a log line `event: storage_usage_unreadable` with the store id.
  - It also sends an `info` alert titled `storage_usage_unreadable`. The alert service throttles one alert per level + title per 5 minutes, which is the dedupe, and an R2 listing outage is platform-wide.
- **Evidence:** the ceiling is a plan limit, not a safety control. Refusing a merchant's upload because OUR bucket listing failed hurts paying merchants for our outage. The admitted bytes are bounded by:
  - the upload rate limiters (`uploadLimiter` 20/min, `dailyUploadLimiter`);
  - the per-route file caps;
  - the image resize.

  Tests in `tests/unit/storage-reserve-burst.test.ts`: on a failed listing the upload is admitted and the alert fires with the store id; a readable counter raises no alert; a capped store over its ceiling gets 402 with the Arabic message.

- **Cost if wrong:** during an R2 listing outage a store can upload past its plan's storage figure, at most the rate-limited volume of that window. The extra bytes count on the next successful listing, and further uploads are refused then.
