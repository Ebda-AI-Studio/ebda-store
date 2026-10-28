# M-OVR-1

> Section: 2026-10-01 — owner decisions #2277 + #1370 (branch `fix/owner-decisions-2277-1370`)

**Ruling M-OVR-1 — admin/manual orders ENFORCE a coupon's rules by default; a store admin may override
them, recorded (owner decision, Ahmad 2026-09-25, #1370).** `createAdminOrder` used to check only the
coupon's dates, store-wide limit and minimum, never its targeting, and discounted the WHOLE subtotal —
so a scoped, customer-group or first-order coupon applied to anything typed into the phone-order form.
It now runs the checkout rules: dates, store-wide usage limit, minimum order, customer group, first
order, minimum quantity, product/category scope (`CouponService.adminOrderCouponViolations`, the
customer context from `resolveCustomerContext`), the per-customer limit inside the order transaction,
and a scoped coupon discounts only its in-scope lines. A broken rule is a 400 with the checkout's error
code. The override (`overrideCouponRules: true` + `couponOverrideReason`, 3–500 chars, Zod-validated at
the route) is honoured only for `store_admin`/`super_admin` — the role comes from the verified token and
the service answers staff with 403 `COUPON_OVERRIDE_FORBIDDEN`. It bypasses every eligibility rule but
never the merchant's own on/off switch (an inactive coupon stays a 404). Under override a scoped coupon
still discounts only its in-scope lines when the order has any; when it has none, it applies to the
whole order — that is the scope rule being overridden. The override is written as a `coupon_override`
orderEvent IN the order transaction (actor, role, reason, the rules actually broken, the discount) and
as an `order.coupon_override` audit-log row the merchant sees on the order timeline (hidden from the
customer's view of it). Admin orders now also RESERVE the redemption (`usageCount` +1, atomically, with
the `< usageLimit` guard unless overridden): they never counted, yet cancelling one ran the fanout's
reverse-coupon step and decremented the count — handing another customer's redemption back. Proven in
`tests/integration/admin-order-coupon-rules.test.ts` (10 tests) and
`tests/unit/admin-order-coupon-override-route.test.ts` (8); 8 mutations each turned a test red. Those
were one-off manual runs; the three that matter most are now committed defences re-run on every
relevant PR by `npm run test:defence-mutations` (issues 2304/2317): `money-admin-coupon-rules-enforced`
(the enforcement throw), `money-admin-coupon-override-role-gate` (the 403 for non-admin roles) and
`money-admin-coupon-atomic-reservation` (the `usageCount < usageLimit` reservation guard, proven by a
test that stubs the pre-check to simulate the losing side of a last-use race). One
mutation survived by design: dropping `isActive` from the coupon lookup leaves the reservation's own
`isActive: true` guard to refuse an inactive coupon (404), so the belt holds without the braces. Cost if
wrong: a store admin can still give any coupon to any order — but never silently, and never as staff.
