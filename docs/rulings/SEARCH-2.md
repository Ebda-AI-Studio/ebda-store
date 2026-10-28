# SEARCH-2

> Section: 2026-10-16 — Search program, PR 1 (P0): SEARCH-\*

Ruling SEARCH-2 — The fold uses no Unicode `normalize()` and no locale lowercasing (ASCII A-Z only), in both TS and SQL. Evidence: neither is reproducible as an IMMUTABLE Postgres function, so they would break parity. Cost if wrong: uppercase accented Latin (É) and presentation-form Arabic ligatures are not folded; both are rare in Egyptian queries.
