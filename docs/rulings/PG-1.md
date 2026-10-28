# PG-1

> Section: 2026-10-03 — scoped-audit follow-ups (branch `fix/backlog-followups11`, issues 2427, 2429-2432, 2434)

**Ruling PG-1 — a paged list ends its sort with a unique key (issue 2429).** `skip`/`take` over a
non-unique sort key is not a stable pager: each page is an independent top-N sort, so rows that tie
can repeat or vanish between pages. `expenses.expenseDate` is a calendar day, so every same-day
expense ties exactly. Fixed with an `id` tiebreaker on the lists that sort by a date or a small
number: expenses, journal entries, bank statements, bank transactions, purchase orders, reorder
suggestions and loyalty members. Pinned by `tests/unit/paged-lists-total-order.test.ts`. Accepted
residual: about 35 other `skip`/`take` lists sort by `createdAt` alone (a millisecond timestamp, tied
only by a bulk insert in one statement) and were not touched; a tie there can still shuffle two rows
across a page boundary. Cost if wrong: an admin list of rows created in one batch can show one row
twice and miss another when paged; the fix is the same one-line `id` tiebreaker.
