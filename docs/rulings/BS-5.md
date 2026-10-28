# BS-5

> Section: 2026-10-01 — backlog batch b-services (branch `fix/backlog-b-services`)

**Ruling BS-5 — issue 1988: Prisma P2003 / P2025 reach Sentry again, at warning level; P2002 and
input-validation errors stay suppressed.** SN-2's safety net ("a first add-to-cart 500 would reappear
and re-open the issue on its own") had silently stopped existing: EBDA-API-28's class is answered 400
since the 2026-09-02 mapping, and #1982 then kept every 4xx out of Sentry. Warning level keeps them
trackable (and able to reopen a resolved issue) without paging like a crash. P2002 is the merchant's
duplicate SKU, a genuine client error. Cost if wrong: a merchant repeatedly deleting an already-deleted
row adds warning-level P2025 noise to Sentry.
