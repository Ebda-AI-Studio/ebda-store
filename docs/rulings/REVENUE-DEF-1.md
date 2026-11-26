# REVENUE-DEF-1

> Section: 2026-11-19 - QA sign-in findings STORE-QA-7 / STORE-QA-22 (branch `fix/revenue-excludes-refunds`)

**Ruling REVENUE-DEF-1 - one definition of net sales, used by every revenue / spend / AOV / "paid"
aggregate.** An order COUNTS unless its status is `cancelled`, `refunded` or
`awaiting_payment_confirmation`, or its payment_status is `failed` or `refunded`. Its AMOUNT is
`total - LEAST(total, GREATEST(sum of its completed non-exchange returns' refund_amount, sum of its
payments.refunded_amount))` (GREATEST, not +: one refund is recorded on both the return and the
payment). Paid-only surfaces (rollups, usage snapshot, funnel, insights) add `payment_status = 'paid'`.
Pending COD stays in: it is sales, not cash.

**Ruling REVENUE-DEF-1b (controller, same day, refines the above): an UNPAID order counts as sales unless its payment INTENT is an online
provider, decided by the order's LATEST payment row (created_at, then id), never by 'any online row'.** A shopper whose card failed
and who then chose COD counts (latest = cod); a pending online row alone does not; an online attempt after a COD one does not; an
order with no payment row counts. Cost if wrong: an order whose latest attempt is online-but-actually-collected-offline is
undercounted until it is marked paid.

**Correction (controller, same day): an UNPAID order counts only when it is not an abandoned online checkout.** An unpaid order
whose latest payment row is an online provider (card, wallet, InstaPay link: any provider outside cod / cash / cash_on_delivery) is a
checkout abandoned at the gateway and is NOT a sale. Unpaid cash on delivery counts, and so does an unpaid order that recorded no
online attempt at all (a phone / admin order the merchant will collect in cash), because orders carry no payment-method column and
the payment rows are the only record of the method. Paid orders count whatever the provider. In SQL the predicate is
`payment_status <> 'unpaid' OR NOT EXISTS (latest payment row is online)`; the pure twin is `latestPaymentIsOnline` / `hasOnlinePayment`.
Refunds are pre-aggregated per order once (two grouped LEFT JOINs on returns(order_id) and payments(order_id), both indexed in
Postgres and in the StoreDO), not as a correlated subquery per row. The SQL lives in `packages/repo/src/revenue.ts` (the
StoreDO and Postgres twins) and is copied byte-for-byte to `apps/api/src/lib/revenue-sql.ts`;
`tests/unit/revenue-definition.test.ts` keeps the copies equal and fails when a revenue surface stops
importing it. Per-line item revenue (top products / categories / price source) and the per-customer
spend strip net a partial refund too: the refund is allocated across the order's lines in
proportion to line total (largest-remainder, so the lines add back to the order's net).
Tile captions say "all orders except cancelled, refunded and failed payments" (the Customers page
caption is the model).
Per-line allocation caps the refund at the sum of the order's lines (the refund may include shipping), so a line's net is never below 0.
Residual (accepted): a payment_status `disputed` still counts as revenue until the dispute resolves to refunded.
Cost if wrong: dashboards overstate by undelivered COD until a collected-cash tile ships.
