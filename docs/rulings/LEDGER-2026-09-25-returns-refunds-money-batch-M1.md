# LEDGER-2026-09-25-returns-refunds-money-batch-M1

> Section: 2026-09-25 — returns/refunds money batch (M1)

Ruling LEDGER-2026-09-25-returns-refunds-money-batch-M1 — unlabelled notes from the legacy ledger section "2026-09-25 — returns/refunds money batch (M1)":

Context: branch `fix/p2-m1-returns-refunds`, 19 issues in the return-completion
and provider-refund path. Measured against Postgres 17 before any change: every
gateway refund made inside a request hung 30,006 ms and ended in P2028, because
the post-provider write was a client-level array transaction that waited on the
row lock its own request held. That finding shapes the rulings below.
