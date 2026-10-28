# SEARCH-T11-11

> Section: 2026-10-15 — Phase B1 Qamar (B1-\*)

Ruling SEARCH-T11-11 (review M6) — the indexer decides what to embed from the doc hash, never from `product.upserted`'s `changedFields`: the per-store 20 s debounce delivers only the LAST event of a window, so filtering on its `changedFields` would drop a text edit followed by a price edit. A price/stock/flag-only edit still enqueues one run, which costs one plan step (three small SQL statements) and no Workers AI call and no write step. Evidence: `tests/integration/product-index.test.ts` "review M6" (steps = `['plan-0']`, 0 provider calls); a mutant that also treats `updated_at > embedded_at` as stale turns it red. Cost if wrong: one Inngest run per debounced burst of non-text edits per store.
