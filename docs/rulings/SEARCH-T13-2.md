# SEARCH-T13-2

> Section: 2026-10-16 — Search program, PR 4, Task 13 (quality eval): SEARCH-T13-\*

Ruling SEARCH-T13-2 — `KEYWORD_STRONG_AT` stays 50 (= `HYBRID_LEG`, SEARCH-T12-3 amended). The eval cannot tell 20, 50 and no threshold apart: every metric is identical because only 1 of 345 queries has 20-49 keyword matches (`t-shirt`, 21 matches, all relevant) and none has 50+. Recorded as not measured, not as "no effect": an Egyptian fashion store with hundreds of products will have broad queries in that band. Revisit with the search log (`search_query_daily` result counts) once a real store has traffic. Cost if wrong: broad queries with 20-49 keyword hits are re-ranked by the vector leg when keyword order alone was better (or the reverse at 20).
