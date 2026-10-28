# SEARCH-T3-1

> Section: 2026-10-16 — Search program, PR 1 (P0): SEARCH-\*

Ruling SEARCH-T3-1 — `bundle.routes.ts:387` and `promotion.service.ts:54` search bundles and promotions, not products, so they go through `searchNameIds` (same `ebda_ar_norm` fold and escaping, per-store sequential filter, no index: tiny per-store tables) instead of `searchProductIds`. Evidence: the planned "through `searchProductIds`" is impossible for those tables. Cost if wrong: a store with thousands of promotions pays a per-row normalisation on each admin search.
