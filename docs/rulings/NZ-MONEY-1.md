# NZ-MONEY-1

> Section: NEON-ZERO money path (2026-11-05)

**Ruling NZ-MONEY-1 - the DO `paymentCreate` charges the amount due, not the order total. Evidence: every Postgres caller (`/payments/create`, payment link, retry) records `order.total - order.walletAmount`, and the DO refused that with `PAYMENT_AMOUNT_MISMATCH` (a wallet-part-paid order could not record its gateway payment; the gateway invoice was then orphaned). The one DO test that paid the full total of a wallet order encoded the wrong amount and now pays the due. Cost if wrong: a caller that really meant the full total of a wallet order is refused 409 instead of over-charging the wallet part.**

Source: `docs/cf/payments-on-do.md` "NEON-ZERO money path".
