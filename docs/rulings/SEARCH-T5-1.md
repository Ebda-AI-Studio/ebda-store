# SEARCH-T5-1

> Section: 2026-10-16 — Search program, PR 1 (P0): SEARCH-\*

Ruling SEARCH-T5-1 — the search-log row date is the Cairo ISO day string (`zonedIsoDay`) cast `::date`, not `regionDayStart(new Date())`. Evidence: with Postgres on TZ=UTC the brief's version stored `2026-10-14` for a search on Cairo day `2026-10-15` (mutation run `_t5_mut_date.log`). Cost if wrong: none; the brief's version miscounts every day.
