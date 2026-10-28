# SEARCH-T11-13

> Section: 2026-10-15 — Phase B1 Qamar (B1-\*)

Ruling SEARCH-T11-13 (review N-M2) — the quarantine key includes the embedding model: `product_embed_failures.model` records the model that rejected the text, and a product is skipped only while `content_hash = md5(current doc) AND model = EMBED_MODEL`, so a model change re-admits every quarantined product (the upsert also refreshes a row whose model differs). The column was added by editing `20261022000200_product_embed_failures` in place: that migration exists only on this unmerged branch and has never run outside throwaway test databases (a local DB that applied the earlier version must be reset). Evidence: `tests/integration/product-index.test.ts` "review N-M2" (red: no column; a mutant without the model comparison keeps the product blocked). Cost if wrong: none.
