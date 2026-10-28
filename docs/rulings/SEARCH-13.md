# SEARCH-13

> Section: 2026-10-16 — Search program, PR 1 (P0): SEARCH-\*

Ruling SEARCH-13 — The old raw-column trigram indexes (`products_{name,name_ar,description,description_ar}_trgm_idx`, `users_*_trgm_idx`, `orders_guest_*`) are NOT dropped in this program. Evidence: DB-INDEX-MIGRATIONS requires a drop to be its own reviewed migration with `idx_scan = 0` evidence over time. Unblock: 30 days after PR 1/PR 5, read `pg_stat_user_indexes` and drop in a follow-up. Cost if wrong: extra write amplification on products/users/orders until then.
