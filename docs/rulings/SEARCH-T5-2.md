# SEARCH-T5-2

> Section: 2026-10-16 — Search program, PR 1 (P0): SEARCH-\*

Ruling SEARCH-T5-2 — the purge is DAILY (`search-log-purge-daily`, `30 4 * * *`), not the brief's weekly; the cutoff is Cairo day minus 90 (rows dated before it go); soft-deleted stores are included (`storeDirectory(…, { includeDeleted: true })`). Evidence: SEARCH-4's 90-day retention is a promise, and a weekly purge overshoots it by up to 6 days. Cost if wrong: one small DELETE per store per day.
