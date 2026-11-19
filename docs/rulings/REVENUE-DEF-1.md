# REVENUE-DEF-1

> Section: 2026-11-19 - QA sign-in findings STORE-QA-7 / STORE-QA-22 (branch `fix/revenue-excludes-refunds`)

**Ruling REVENUE-DEF-1 - one definition of net sales, used by every revenue / spend / AOV / "paid"
aggregate.** An order COUNTS unless its status is `cancelled`, `refunded` or
`awaiting_payment_confirmation`, or its payment_status is `failed` or `refunded`. Its AMOUNT is
`total - LEAST(total, GREATEST(sum of its completed non-exchange returns' refund_amount, sum of its
payments.refunded_amount))` (GREATEST, not +: one refund is recorded on both the return and the
payment). Paid-only surfaces (rollups, usage snapshot, funnel, insights) add `payment_status = 'paid'`.
Pending COD stays in: it is sales, not cash. The SQL lives in `packages/repo/src/revenue.ts` (the
StoreDO and Postgres twins) and is copied byte-for-byte to `apps/api/src/lib/revenue-sql.ts`;
`tests/unit/revenue-definition.test.ts` keeps the copies equal and fails when a revenue surface stops
importing it. Per-line item revenue (top products / categories / price source) and the per-customer
spend strip net a partial refund too: the refund is allocated across the order's lines in
proportion to line total (largest-remainder, so the lines add back to the order's net).
Tile captions say "all orders except cancelled, refunded and failed payments" (the Customers page
caption is the model).
Cost if wrong: dashboards overstate by undelivered COD until a collected-cash tile ships.
