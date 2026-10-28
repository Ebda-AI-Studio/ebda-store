# SEARCH-P2-5

> Section: 2026-10-16 — Search program, PR 4, Task 13 (quality eval): SEARCH-T13-\*

Ruling SEARCH-P2-5 (Task 16/17) — the per-key trigram indexes (`orders_guest_first_name / last_name / phone_trgm_idx`, `users_first_name / last_name / phone_trgm_idx`) and the `ebda_order_search_ids` kinds `'guest'` and `'customers'` are no longer called by the app. They stay one release for rollback. TRACKED: a CONTRACT migration drops them (ROADMAP "Search program" follow-up; plan PR 5 boundary), never in the same deploy as the code that stopped using them. Cost if wrong: six redundant GIN indexes make every write to orders and users dearer until it runs.
