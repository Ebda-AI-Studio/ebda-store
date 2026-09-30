---
feature: loyalty-redemption
updated: 2026-06-14
---

# UAT: Loyalty Points Redemption at Checkout

**Reviewer account:** a **logged-in customer** with a loyalty balance (not a guest)
**Admin observer account:** store_admin for the same store (to confirm balances + transactions)

**Pre-conditions:**

- Store on a plan that includes Loyalty (Professional+) **or** with the `loyalty` feature override on.
- Loyalty enabled on the store with settings: `pointsValue` (fils per point),
  `minRedeemPoints` (e.g. 500), `maxRedeemPercentage` (e.g. 50).
- The reviewer customer has a positive points balance ≥ `minRedeemPoints`
  (admin can award points via **Loyalty → member → Award**, or place + deliver a
  prior order so points are earned).
- A test store with ≥1 in-stock product (price > 0).
- Payment provider in **test mode** (MyFatoorah / COD).
- Preview/staging env only — **never run against prod**.

**Browser matrix:** Chrome latest · Safari latest · mobile Safari iOS 17+ · test in **both EN and AR** (RTL).

---

## Golden path — redeem points for a discount

1. Sign in as the reviewer customer on the storefront.
2. Add a product to the cart whose price comfortably exceeds the redeemable value
   (e.g. a 10 KWD item with a 2000-point balance @ 1 fil/point).
3. Open `/account/loyalty` → note the **current balance** (e.g. 2000 points).
4. Go to checkout. In the **Order Summary**, verify the **"Use loyalty points"**
   control appears, showing the balance and its cash value (e.g. "Balance: 2,000
   points · worth 2.000 KWD").
5. Tick **Use loyalty points**. Verify the points input defaults to the full balance
   and a **Max** button is present.
6. Verify a **Loyalty points** discount line appears in the totals and the **Total**
   drops by exactly `points × pointsValue` (e.g. −2.000 KWD).
7. Reduce the points in the input (e.g. to 1000) → verify the discount + total update
   live to match.
8. Complete the order (COD → success page; online → test-mode gateway → success).
9. **Verify balance decremented:** reopen `/account/loyalty` → balance reduced by
   exactly the redeemed points (e.g. 2000 − 1000 = 1000).
10. **Verify transaction logged:** the loyalty history table shows a **redeem
    discount** row with the negative points (e.g. −1,000) and a description naming
    the KWD discount.
11. **Admin cross-check:** in admin Loyalty → the member → the same `redeem_discount`
    transaction is visible; the order detail shows the loyalty discount in the total.
    Open the same order in the orders app (orders.force-ai.co) too: its summary card
    shows the same "Loyalty points (N)" line, not a generic "Discount" line. The
    invoice (Invoice button) and the order-confirmation email show it the same way,
    and the orders XLSX export has a "Loyalty Discount (KWD)" column.

**Switch language to Arabic and repeat steps 4–7** — the control reads
"استخدام نقاط الولاء", the discount line reads "نقاط الولاء", and the layout is RTL-correct.

---

## Edge case — insufficient / below-minimum points

1. As a customer whose balance is **below `minRedeemPoints`** (e.g. 300 with a 500
   minimum), go to checkout.
2. Verify the **"Use loyalty points"** control does **not** offer a usable redemption
   (no balance shown / toggling yields no discount), OR entering a sub-minimum amount
   shows the **"Minimum N points to redeem"** hint and applies no discount.
3. If you force a sub-minimum `pointsToRedeem` (e.g. via the input), confirm the order
   total is **unchanged** and no points are deducted after placing the order.

## Edge case — discount cap at subtotal / percentage

1. As a customer with a large balance (e.g. 50,000 points), add a small-value item
   (e.g. 2 KWD) to the cart.
2. Tick redeem and choose **Max**.
3. Verify the discount is **capped** at the lower of the subtotal and
   `maxRedeemPercentage`% of it — the **Total never goes negative** and never exceeds
   the goods value.
4. Place the order → verify the **points actually deducted** match the capped discount
   (you keep the remainder), not the full requested amount.

## Edge case — refund re-credit

1. Place an order redeeming points (as in the golden path); note the post-redeem
   balance.
2. As admin, change the order status to **Refunded** (or **Cancelled**).
3. Reopen `/account/loyalty` → verify the redeemed points are **returned** to the
   balance (back to the pre-redeem value) and a **re-credit** (`adjust`, positive
   points) transaction is logged.
4. Refund/cancel a second time (or re-trigger the refund effects) → verify the points
   are **NOT credited twice** (idempotent — balance unchanged on the second pass).

## Edge case — guest checkout

1. Sign out (or use a fresh session). Add a product and go to checkout as a **guest**.
2. Verify the **"Use loyalty points"** control does **not** appear at all.
3. Place the order → verify the order has **no loyalty discount** and the total equals
   subtotal + shipping − any coupon.

---

## Sign-off checklist

- [ ] Discount equals points × pointsValue exactly (no rounding leak).
- [ ] Balance decremented by the exact redeemed amount, atomic with the order.
- [ ] `redeem_discount` transaction visible on customer + admin loyalty pages.
- [ ] Below-minimum and over-cap requests are safely clamped server-side.
- [ ] Refund/cancel re-credits points exactly once.
- [ ] Guests cannot redeem; control hidden.
- [ ] EN + AR both correct, RTL-clean.
