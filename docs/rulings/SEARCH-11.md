# SEARCH-11

> Section: 2026-10-16 — Search program, PR 1 (P0): SEARCH-\*

Ruling SEARCH-11 — The index is BOUNDED-stale (debounce 20 s + the Inngest queue; backstop ≤ 6 h for any missed writer). It never serves price, stock or status, which are read live and filtered in the same SQL. Cost if wrong: a just-renamed product ranks by its old name for up to ~1 min.
