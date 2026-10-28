# SEARCH-T5-4

> Section: 2026-10-16 — Search program, PR 1 (P0): SEARCH-\*

Ruling SEARCH-T5-4 — bloat cap: at most 1,000 distinct terms per store per Cairo day (`SEARCH_LOG_MAX_TERMS_PER_DAY`), enforced in the same INSERT (`WHERE EXISTS(term) OR count(day) < cap`); known terms keep counting; counters saturate below INT4 max; soft under concurrency (a few over). Cost if wrong: a store with more than 1,000 distinct daily terms loses its long tail for that day, and about 1,000 junk terms early in a Cairo day block every NEW legitimate term for that store for the rest of the day (existing counts unaffected, public rate limiters apply, analytics only, no privacy or security impact).
