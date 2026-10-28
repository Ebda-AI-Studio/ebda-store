# SEARCH-P2-2

> Section: 2026-10-16 — Search program, PR 4, Task 13 (quality eval): SEARCH-T13-\*

Ruling SEARCH-P2-2 (Task 16) — the phone arm of the customer lookup is built only for a term made of digits and phone punctuation, and a token with no letter (digits, "+20") is never a name token. Evidence: the Task 14 planner suite's 10-hex-digit terms ("a3f09b1c4e") added a broad digits arm and took 6 s. Cost if wrong: "ahmed 0101" is a name search with the phone arm off; type the number alone to search by phone.
