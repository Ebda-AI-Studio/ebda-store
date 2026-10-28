# SEARCH-P2-3

> Section: 2026-10-16 — Search program, PR 4, Task 13 (quality eval): SEARCH-T13-\*

Ruling SEARCH-P2-3 (Task 17) — a lone "%" or "\_" in the ORDER list used to match every order: Prisma `contains` does not escape LIKE metacharacters, and an old test asserted that as "literal". A term holding a metacharacter now takes the escaped lookups at any length, and the test says it matches nothing. Cost if wrong: none (an order number that contains "%" is still found).
