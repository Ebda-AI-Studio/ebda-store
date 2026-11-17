# SUSPEND-REFUND-1 - a suspension never strands a customer's money

Ruling SUSPEND-REFUND-1 (controller, money review of #739/#674, 2026-11-17) - a suspended store stays read-only (TEN-1), except for money going back to customers.

- **Billing suspension** (`billingSuspendedReason` set: unpaid, over_store_limit): the merchant can still refund customers and cancel orders.
  - Allowed: POST `/payments/refund`, and on `/stores/:id/orders/:id/` the routes `refund-via-provider`, `instapay-refund`, `refund-match-claim`, `refresh-refund-status`, plus PUT `status` when the body is `cancelled` or `refunded`.
  - Every other write stays blocked.
  - The check is `isCustomerMoneyBackRoute` + the `moneyBack` flag in `apps/api/src/middleware/store-access.ts`, with anchored paths.
- **Platform suspension** (abuse / fraud): the merchant is refused (403 `STORE_SUSPENDED`).
  - A super admin refunds on the store's behalf through POST `/payments/refund`, which requires a written `reason` (≥ 3 chars, else 400 `REASON_REQUIRED`).
  - That refund is audited as `payment.refund_requested_for_suspended_store` with `onBehalfOfSuspendedStore: true`.
  - The order routes stay merchant-only (ORDER-MONEY-SUPERADMIN): there the super admin's path is the payment refund, and cancelling an unpaid order moves no money.
- Evidence: `tests/unit/store-suspended-readonly.test.ts` (SUSPEND-REFUND-1 block) and `tests/unit/suspend-refund-route.test.ts`.

Cost if wrong: a billing-suspended merchant can refund and cancel, which is money leaving the store to customers, never to the merchant. A platform-suspended store's customers wait for a super admin to refund.

Amendment (2026-11-17, after #804 landed on main): the way OUT of a suspension stays open too. `POST /stores/:id/suspension/appeal` and `POST /stores/:id/support-requests` are never refused by the read-only gate, whatever the suspension (`isStoreSupportRoute` in `middleware/store-access.ts`). The appeal route itself decides what can be appealed (a billing suspension is settled on the Billing page, 409), and the over-limit 402 is decided before the gate. Tests: `tests/unit/suspended-store-support-exempt.test.ts`, `tests/unit/suspended-store-admin-reaches-appeal.test.ts`. Cost if wrong: a suspended merchant could file many support requests; the support route's own limiter bounds that.
