# SEARCH-T3-4

> Section: 2026-10-16 — Search program, PR 1 (P0): SEARCH-\*

Ruling SEARCH-T3-4 — the planner test fills products with ~330-character descriptions. Evidence: with empty descriptions Postgres under-costs the per-row normalisation filter and picks the `store_id` btree for the admin OR at 20k rows (measured; the BitmapOr runs about 1.7 ms on a realistic fill). Cost if wrong: a production store with near-empty descriptions may plan a `store_id` scan plus filter (correct results, slower).
