# SEARCH-8

> Section: 2026-10-16 — Search program, PR 1 (P0): SEARCH-\*

Ruling SEARCH-8 — Exact KNN per store (btree `store_id` + ORDER BY distance), no HNSW. Evidence: per-store catalogues are hundreds to low thousands of rows [i], and filtered HNSW has a recall trap. Cost if wrong: a 20k+ product store pays a slower vector leg; revisit with `EXPLAIN ANALYZE` when any store passes 20k.
