# SEARCH-P2-1

> Section: 2026-10-16 — Search program, PR 4, Task 13 (quality eval): SEARCH-T13-\*

Ruling SEARCH-P2-1 (Search P2 Task 16) — a GUEST row in the customers list or export built by a search aggregates only the guest orders that matched the term. When one contact placed orders under different names, a name search undercounts that guest's orders and total; the customer page, keyed by email or phone, is complete. Matching on the contact key instead would need a second round trip per guest. Cost if wrong: a guest's order count under a name search is partial.
