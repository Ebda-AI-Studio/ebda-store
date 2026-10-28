# IDX-2

> Section: 2026-10-01 — Missing indexes / order search (`perf/missing-indexes`, issue #2405)

**Ruling IDX-2 — no `carts (store_id, created_at)` index.** The only query that needs it is the
funnel rollup's per-day cart count: 13 ms in production, 7 calls per store from the daily 02:00
cron. Cost if wrong: that nightly job slows linearly with cart volume.
