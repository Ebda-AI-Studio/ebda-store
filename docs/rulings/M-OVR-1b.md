# M-OVR-1b

> Section: Backlog batch followups (2026-10-01, branch `fix/backlog-followups`)

**Ruling M-OVR-1b — the pre-cutover admin-order check runs outside the coupon money transaction
(issue 2359; amends M-OVR-1a).** `withRlsBypass` opens its own `$transaction` on a second pool
connection; calling it inside `withMoneyTx` held one connection while waiting for another (the
double-nest hazard). The `order.admin_created` lookup is now its own `step.run`
(`admin-created-lookup`) before `reverse-coupon`, and only for an order with a coupon created
before `ADMIN_COUPON_RESERVE_CUTOVER`; its result (immutable history) is passed into the
transaction. A sweep of all 132 `withRlsBypass` call sites found no other one nested inside an
explicit transaction. NOT done: an index on `audit_logs(resource_type, resource_id)` — the lookup
is no longer inside a money transaction, runs once per pre-cutover couponed order and has the
`action` index; a new index on the largest append-only table is not worth its write cost for a
shrinking historical set. Cost if wrong: that one-off lookup is a slower scan on a store with a
very large audit log.
