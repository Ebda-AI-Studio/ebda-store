# SEARCH-P2-4

> Section: 2026-10-16 — Search program, PR 4, Task 13 (quality eval): SEARCH-T13-\*

Ruling SEARCH-P2-4 (Task 17) — the order-number DIGITS arm ("#١٢٣٤" finds "EB-1234") applies only to a term made of digits, "#", spaces and dashes. A mixed term such as "Gwendolyn58123" must not become an order-number filter (it matched every order in order-search-guest-contact). Cost if wrong: an "EB 1234" style term relies on the plain ILIKE arm only.
