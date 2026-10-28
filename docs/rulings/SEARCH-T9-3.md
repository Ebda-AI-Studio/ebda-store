# SEARCH-T9-3

> Section: 2026-10-15 — Phase B1 Qamar (B1-\*)

Ruling SEARCH-T9-3 — `product_embeddings` is part of the RLS payload-parity fixture: `scripts/rls-payload-parity.mjs --seed` writes one vector per fixture product (raw SQL; Prisma cannot write `halfvec`), so the storefront search vector leg (Task 12) is diffed owner vs `ebda_app` from the day it reads the table. Evidence: local run on pgvector, 123 comparisons, PASS, 8 vectors seeded. Cost if wrong: none; the rows are fixture-only.
