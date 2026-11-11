# MONEY-CEIL-1

> Section: 2026-11-12 (issue #624, money backfill audit)

**Ruling MONEY-CEIL-1 - every refund channel shares ONE per-order refundable balance,
`refundableBalance()` in `packages/repo/src/do/refundable.ts`, read inside the same DO
section as the write.** paid = the order total once captured (else the wallet share it
spent); refunded = `SUM(payments.refunded_amount)` (card, InstaPay, merchant-recorded
manual refunds, open claims) + wallet `refund_credit` / `order_payment_reversal` credits +
completed cash / bank_transfer / manual returns + merchant-booked partial amounts. Writers:
`beginRefund` (caps the claim; "refund the rest" claims only the rest), `recordInstapayRefund`,
`claimReturn` (early refusal, and `ORDER_ALREADY_REFUNDED` on a refunded order), `finishReturn`
(store credit / manual: the section rolls back if it would pass the ceiling), `refundOrder`
partial store credit, `reverseOrderPayment` (wallet give-back capped), and the new
`recordManualRefund` DO op (the Prisma version cannot run in the Worker since NZ-D23; it now
records only what is left). Decisions inside it: (1) provider facts (completeRefund, settle
webhooks) are never refused, they are recorded and flagged `review`; (2) a gateway return's
wallet share, credited after the provider already paid, is capped at what is left rather than
refused; (3) partial-refund events written before this change carry no `external` flag and are
counted as merchant-booked, which over-counts a pre-#624 provider partial (conservative,
pre-launch: test stores only). Evidence: `packages/repo/test/do-refund-ceiling.test.ts`, 9
cases, all red on origin/main. Cost if wrong: a legitimate refund on an order with pre-#624
partial provider refunds is refused with REFUND_EXCEEDS_ORDER and the merchant has to settle it
by hand.
