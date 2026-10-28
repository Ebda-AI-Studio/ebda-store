# SEARCH-P2-10

> Section: 2026-10-16 — Search program, PR 4, Task 13 (quality eval): SEARCH-T13-\*

Ruling SEARCH-P2-10 (review I1) — the ⌘K route has its own per-user limiter (`adminSearchLimiter`, 120 requests/minute, keyed by user id so an office sharing one IP is not throttled together), because GETs skip the global limiter. It also runs ONE customer lookup with small caps (50 registered customers, 200 guest orders, 50 order-number ids) that the order search reuses, and skips the order search for a two-character term. A 429 shows a distinct rate-limited state in the palette (ar and en). Cost if wrong: a very fast typist could see the rate-limited notice; the budget is 120/min.
