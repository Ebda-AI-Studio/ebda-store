# SEARCH-T13-1

> Section: 2026-10-16 — Search program, PR 4, Task 13 (quality eval): SEARCH-T13-\*

Ruling SEARCH-T13-1 — `SEARCH_VECTOR_MAX_DISTANCE` stays 0.55. Current state (two vectors, SEARCH-T13-7; run 2 with AI words): core hit-rate@10 / MRR / nDCG@10 at 0.45 = 0.88 / 0.85 / 0.69 (fails overall, franco, floors and lift); at 0.55 = 0.96 / 0.90 / 0.81 (PASSES every check); at 0.65 = 0.96 / 0.90 / 0.82 (passes, no hit-rate gain) while off-type negatives in the top 10 rise 0.99 → 1.29 per query and every absent-product query is answered with 10 products (0.55: 92 %, ~7.5). A cut-off cannot fix the false positives: the nearest product to an absent query sits at median cosine distance 0.47, inside the relevant range (msa nearest-relevant median 0.40, Franco 0.54). Cost if wrong: a few queries per hundred whose right product sits between 0.55 and 0.65 miss the first 10.
