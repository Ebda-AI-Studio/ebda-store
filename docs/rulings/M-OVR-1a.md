# M-OVR-1a

> Section: 2026-10-01 — owner decisions #2277 + #1370 (branch `fix/owner-decisions-2277-1370`)

**Ruling M-OVR-1a — cancelling an admin order created before admin orders reserved their coupon does
not decrement `usageCount` (issue 2303, backlog batch x-api).** M-OVR-1 made admin orders reserve the
redemption from PR 2300 on, but every earlier admin order never counted, and the fanout's
reverse-coupon step still decremented on its cancel — handing another customer's live redemption back
to the limit, the defect M-OVR-1 says it closes. No forward marker can fix rows that already exist, and
a backfill would be a production data write, so the step now classifies the legacy row instead: an
order created before `ADMIN_COUPON_RESERVE_CUTOVER` (the PR 2300 merge, 2026-09-30T11:47:49Z) that has
an `order.admin_created` audit row is skipped and marked `coupon_reversed` (`metadata.skipped =
admin_order_never_reserved`) so a redelivery skips it cheaply. Checkout orders always reserved and are
unchanged. `rollbackForPaymentFailure`'s decrement gained the same `usageCount > 0` floor as the fanout.
Proven in `tests/integration/admin-order-coupon-rules.test.ts` (2 more tests); disabling the guard turns
the pre-cutover test red. Cost if wrong: two residual windows, both the old behaviour — an admin order
created between the PR 2300 merge and its deploy did not reserve but is treated as reserved (its cancel
still decrements), and a pre-cutover admin order whose best-effort audit row failed to write is
treated as a checkout order (same).
