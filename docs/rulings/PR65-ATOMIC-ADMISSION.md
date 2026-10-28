# PR65-ATOMIC-ADMISSION

> Section: BOSTA-LIVE-READONLY (2026-10-08)

Ruling PR65-ATOMIC-ADMISSION — remove the previously accepted concurrent-count race. Sorted transaction-scoped tenant/phone/email/IP locks and the count run inside the same money transaction as stock reservation/order insertion. Full-wallet orders are exempt; partial-wallet orders remain capped. Canonical email matching includes legacy stored casing/whitespace. Evidence: pre-fix real-Postgres concurrency/email tests failed and the full-wallet checkout reproduced the false rejection. Cost if wrong: stock can remain pinned without payment or legitimate shoppers can be blocked.
