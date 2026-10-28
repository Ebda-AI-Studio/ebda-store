# SEARCH-T11-17

> Section: 2026-10-15 — Phase B1 Qamar (B1-\*)

Ruling SEARCH-T11-17 (accepted residual, Task 11 re-review) — the quarantine alert can UNDERCOUNT on an Inngest retry of a write step. The P1 counts the rows the quarantine upsert newly inserted or changed (`RETURNING` only fires for a new row, a new text/model, or a re-quarantine after expiry, SEARCH-T11-15); if a `write-N` step commits its quarantine rows and then fails before Inngest records its result, the retried step finds the rows already current, returns 0, and that run's summary alert (or the absence of one) misses them. The rows themselves are correct. Evidence: `quarantineEmbedFailures` + `alertQuarantined` in `product-index.service.ts`; a failure between the statement's COMMIT and the step result is the only path. Cost if wrong: one quarantine event without its P1; the product still shows in `product_embed_failures` and in `storeIndexStatus.failed` (Task 12 viewer, the "N failed" line).
