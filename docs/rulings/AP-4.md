# AP-4

> Section: 2026-09-30 — accounting + profit batch (branch `fix/accounting-profit-batch`)

**Ruling AP-4 — the ledger correction for ORD-1781512189610-9972A710 reverses the
erroneous reversal (JE-2026-000020) with the standard `reverseEntry`.** No row is
edited or deleted. The re-booked sale carries source id `…:reversal:reversal`,
which `postRefundJournal` does not look for. Cost if wrong: if that one order is
ever genuinely refunded, its 9.500 EGP sale stays booked until reversed by hand.
Script: `scripts/fix-ledger-order-mismatch-2026-09-30.ts` — NOT RUN, awaits Ahmad. Its optional
`--fix-stock` step refuses (dry run included) if any of the three products has a variant, and re-checks
that under the row lock: `products.inventory` is not a variant product's stock (issue 2273). It busts the
storefront product caches after commit rather than waiting out the TTL.
