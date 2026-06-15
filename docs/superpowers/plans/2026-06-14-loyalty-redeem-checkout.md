# Loyalty redemption at checkout — end-to-end wiring

Date: 2026-06-14
Branch: `feat/loyalty-redeem-checkout`

## Problem

`LoyaltyService.redeemPoints` is built + race-safe but never called. Customers
can EARN points (credited on `delivered`) but cannot SPEND them. Wire redemption
end-to-end: apply points at checkout for a discount, re-credit on refund/cancel.

## Design decisions

1. **When points are deducted = order CREATE** (not delivery). The discount lands
   on the order total at creation, so the deduction must commit atomically with the
   order row. Earn stays on `delivered` (unchanged) — redeem is the inverse-timed
   sibling: spend up front, earn on fulfilment.

2. **Atomicity.** `redeemPoints` currently runs on the global `prisma` client.
   Add an optional `tx` (`Prisma.TransactionClient`) param so the conditional
   `updateMany` gate+decrement and the `redeem_discount` transaction row commit
   INSIDE the order's `withMoneyTx`. Never deduct without an order; never create the
   order without deducting.

3. **Server-side money math.** Never trust a client discount. The server:
   - reads the customer's balance + store loyalty settings,
   - validates `pointsToRedeem >= minRedeemPoints`,
   - caps points at the customer's available balance,
   - caps the discount at `min(subtotal, maxRedeemPercentage% of subtotal)`,
   - recomputes `discountFils = effectivePoints * pointsValue`,
   - applies it into `discount` + `total`, records `loyaltyPointsRedeemed` +
     `loyaltyDiscount` (fils) on the order.
     A shared pure helper `computeRedemption(settings, pointsToRedeem, subtotalFils,
availablePoints)` holds the math (unit-tested). Points are reduced so the
     discount never exceeds the cap — we only burn what we credit.

4. **Guests cannot redeem.** No `customerId` → ignore the field entirely.

5. **Refund/cancel re-credit.** `reverseRedeemedPointsFromOrder` mirrors
   `reverseEarnedPointsFromOrder`: find the `redeem_discount` tx for the order,
   re-credit `points` (+ NOT totalRedeemed-bump — instead decrement totalRedeemed
   back), idempotent via a tagged `adjust` row (`redeem-recredit:<txId>`). Wired in
   `applyRefundEffects` next to the earn-reversal.

6. **DB.** Order is FORCE-RLS (tenant-scoped). Adding columns to an RLS table needs
   NO new policy — table-level RLS covers all columns. Additive hand-written
   migration + schema.prisma.

## Layers

- DB: `Order.loyaltyPointsRedeemed Int?`, `Order.loyaltyDiscount Int @default(0)` (fils).
- Service: `redeemPoints(..., tx?)`, `reverseRedeemedPointsFromOrder`, `computeRedemption` helper.
- API: `createOrderSchema.pointsToRedeem` (public), validate+apply in `OrderService.create`, reverse in `applyRefundEffects`.
- Web: redeem control in `CheckoutClient` + `OrderSummary` (logged-in only), `pointsToRedeem` to `createOrder`; loyalty account page renders `redeem_discount` rows.
- Tests: unit (math/cap/min/guest), integration (create→decrement+tx; refund→re-credit once; concurrent double-redeem race).
- Docs: `docs/uat/loyalty-redemption.md`, `docs/business/02-feature-catalog.md`.

## Discipline

Money in fils (int). `withMoneyTx`. Idempotent reverse. Platform-level (storeId-scoped).
RLS-aware. Lowercase commits.
