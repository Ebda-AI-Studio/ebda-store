# NZ-MONEY-4

> Section: NEON-ZERO money path (2026-11-05)

**Ruling NZ-MONEY-4 - a `completed` gateway delivery confirms a DO order only when it states the amount due (within 5 piastres) in the payment's currency; a short, over or missing amount, or another or missing currency, is recorded in full on the payment (`reconciliation` event, `amountMismatch` metadata), the order is NOT marked paid and a P1 `amount_mismatch` is raised. Evidence: review I-4 of PR 455 (`under` only caught a short payment in the same currency). Tests: `do-payment-ops.test.ts` (5 cases + wallet split), `money-path.test.ts` (a validly signed wrong amount per provider is held). Cost if wrong: a gateway that legitimately reports a fee-adjusted amount leaves the order unpaid until a merchant confirms it from the alert.**

Source: `docs/cf/payments-on-do.md` "NEON-ZERO money path".
