# SEARCH-16

> Section: 2026-10-16 — Search program, PR 1 (P0): SEARCH-\*

Ruling SEARCH-16 — pre-launch, the CONCURRENTLY index pre-builds (STOP-1 and STOP-5 in the plan) are waived because products, users and orders are empty in production (Ahmad 2026-10-15: "we have not launched, so anything can be done freely"); the migration builds the indexes directly. The documented pre-build procedure in `docs/DB-INDEX-MIGRATIONS.md` stays for post-launch migrations. STOP-2 (pgvector available) is cleared (0.8.0 listed in `pg_available_extensions`, read-only check 2026-10-15); STOP-3 and STOP-4 are authorized, and `SEARCH_SEMANTIC_ENABLED` still turns on only when the quality bar of SEARCH-10 holds. Cost if wrong: none pre-launch.
