# S3-X8: enforce maxStorageMb (2026-11-12)

Problem: `maxStorageMb` is declared per plan (free 500, one plan 20000) and shown on the billing page, but `countUsage` returned null, so nothing was ever refused.

Plan

1. Usage = sum of R2 object sizes under `stores/<id>/` (originals and variants), paged 1000 keys, capped at 50 pages (a lower bound, never zero). `lib/storage-usage.ts`.
2. Staleness class: BOUNDED-stale, 60 s in-memory TTL. Residual: uploads inside one window can overshoot by that window's bytes. Not money or permissions.
3. `assertStorageRoom(storeId, bytes)` = `assertWithinLimit(..., 'maxStorageMb', { delta })`, called in `/uploads/image`, `/images`, `/video`, `/font` after store access is proven. 402 PLAN_LIMIT_REACHED, bilingual message already in `plan-limits.ts`. `null` = unlimited, so plans without a ceiling behave as before.
4. Tests: `tests/unit/storage-usage.test.ts` (paging, cap, TTL, all four routes wired, countUsage no longer null).

Behaviour change: a free-plan store already over 500 MB is refused new uploads. Prelaunch, no live merchants affected; confirm before launch.
