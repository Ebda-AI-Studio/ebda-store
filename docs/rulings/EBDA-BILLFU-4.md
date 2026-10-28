# EBDA-BILLFU-4

> Section: 2026-10-07 — Legal pages v1.0 (branch `docs/legal-pages`)

Ruling EBDA-BILLFU-4 — `tests/integration/vat-gate.test.ts` "while Ebda VAT is OFF a subscription checkout is the plan price alone" was RED on main (bba7b3a9): #17 was written before #15's Ruling EBDA-FUNNEL-17 made hosted checkout refuse with `CARD_PAYMENTS_DISABLED` unless `BILLING_TRIAL_CARD_MODE=card_on_file`. Fixed in the test (a scoped `withCardMode` wrapper), not in the product: InstaPay-only is the intended default. Cost if wrong: none; the card path is still exercised explicitly.
