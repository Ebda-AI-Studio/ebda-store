# DBM-2

> Section: 2026-10-03 — DB maintenance (pg_stat_statements + redundant prefix indexes)

**Ruling DBM-2 — `product_variants_sku_idx` is kept.** The request was to drop it "if it is truly
never used". It has 0 scans, but it is the only index on `product_variants.sku` and
`stock-adjustments.routes.ts` runs `sku IN (…)` against it; the table is 353 rows, so the planner
seq-scans and the zero says nothing. Cost if wrong: 32 kB and one index of write cost on a small
table until the barcode and bulk-stock features have run and the count is re-read.
