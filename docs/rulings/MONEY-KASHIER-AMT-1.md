# MONEY-KASHIER-AMT-1

> Section: 2026-11-12 (issue #625, money backfill audit)

**Ruling MONEY-KASHIER-AMT-1 - a Kashier status answer with no amounts is reported as
UNKNOWN (`paidAmount` / `refundedAmount` undefined), never 0, and the confirm path then uses
the amount the payment was created for.** Kashier's documented order-search projection has
no amount fields, so the adapter flags `amountsKnown: false` and `V2ProviderBridge` drops the
placeholder zeros. `confirmPaymentFromProviderStatus` already treats an unreported amount as
"status only" (the gateway-agnostic rule: never block a paid order on missing data), and
`applyPolledStatusOnDo` already falls back to `payment.amount`. That fallback is safe here
because the status comes from an authenticated server-side query (money rubric #12) and a
Kashier hosted session's amount is fixed when we create it. Kashier documents no detail
endpoint that carries amounts, so the "fetch the amount" option in the issue would invent an
API. Evidence: `tests/unit/v2-bridge-unknown-amount.test.ts` fails on main;
`tests/unit/payment-confirm.test.ts` "no paidAmount reported" covers the confirm half. Cost
if wrong: if Kashier ever captured less than the session amount and the signed webhook never
arrived, a status poll would mark the order paid at the full amount; the daily settlement
reconciliation (rubric #14) is the backstop.
