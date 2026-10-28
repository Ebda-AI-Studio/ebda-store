# SEARCH-T3-2

> Section: 2026-10-16 — Search program, PR 1 (P0): SEARCH-\*

Ruling SEARCH-T3-2 — exports pass `limit: PRODUCT_SEARCH_MAX_LIMIT` (10,000, matching their `take: 10000`) instead of the 1,000 cap. Evidence: otherwise a broad export search would silently drop rows. Cost if wrong: a 10k-id IN list on export (sound in principle, not load-tested).
