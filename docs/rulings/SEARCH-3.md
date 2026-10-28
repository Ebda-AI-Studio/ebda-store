# SEARCH-3

> Section: 2026-10-16 — Search program, PR 1 (P0): SEARCH-\*

Ruling SEARCH-3 — `products.search_terms` ships in P0 as a manual field, before AI fills it. Evidence: it fixes the doc functions' signature, so P1 needs no index rebuild, and merchants can add "3abaya" from day one. Cost if wrong: an empty column on most rows until P1, which costs nothing.
