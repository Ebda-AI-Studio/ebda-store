# IDX-1

> Section: 2026-10-01 — Missing indexes / order search (`perf/missing-indexes`, issue #2405)

**Ruling IDX-1 — no `orders (store_id, status, created_at DESC)` composite.** At 50k orders/store
the status-filtered page is 0.5–4.5 ms (backward scan on `orders_created_at_idx`), the status count
is 28 ms, and production is 0.10 ms. Adding it would be speculative. Cost if wrong: a store with a
very rare status deep in a large history pays a longer backward walk until this is revisited.
