# MONEY-KASHIER-AMT-1

> Section: 2026-11-12 (issue #625, money backfill audit; corrected after the #685 review)

**Ruling MONEY-KASHIER-AMT-1 - a Kashier status answer with no amounts reports them as
UNKNOWN (`paidAmount` / `refundedAmount` undefined), never 0. The poll then confirms at the
amount the payment was created for, and the payment is MARKED as confirmed by status only.**
Kashier's documented order-search projection has no amount fields, so the adapter flags
`amountsKnown: false` and `V2ProviderBridge` drops the placeholder zeros.
`applyPolledStatusOnDo` sends the DO `amountUnverified: true`. The DO confirms the order but
writes `amountUnverified: true` / `amountSource: 'status_poll_expected'` on the payment
metadata, plus a `confirmed_by_status_only` timeline event, so a person can tell these
confirmations apart. This matches the existing NZ-MONEY-4 status-poll exception
(`docs/cf/payments-on-do.md`). Kashier documents no detail endpoint that returns amounts, so
the issue's "fetch the amount" option would invent an API.

**Backstop (the only one; there is no settlement reconciliation job):** the DO amount check
on the signed webhook. When Kashier's signed delivery arrives later, `applyPaymentWebhook`
compares the stated amount and currency with the payment. A short, over, other-currency or
missing amount is recorded (`reconciliation` event, `amountMismatch`) and raises the P1
`amount_mismatch` alert. For a status-only-confirmed payment, the alert says the order was
ALREADY confirmed at the full amount and must be settled before fulfilling. A matching signed
webhook clears the mark (`amountSource: 'signed_webhook'`).

Evidence: `tests/unit/v2-bridge-unknown-amount.test.ts` (fails on main),
`packages/repo/test/do-status-only-confirm.test.ts` (the mark, the P1 on a short signed webhook
after a status-only confirm, the clear on a matching one) and
`tests/unit/polled-status-amount-unverified.test.ts`. Cost if wrong: if the signed webhook
never arrives, a status-only order that was in fact paid short stays confirmed at the full
amount with only the `amountUnverified` mark to show it. Nothing pages on an old unverified
mark today.
