# Adversarial audit — MONEY (slug: `money`)

Repo: <repo> (this checkout, read-only, main)
Method: traced checkout → payment → webhook → refund → reversal end-to-end in code; every finding below carries a concrete exploit path. Prior money audits read: `docs/audits/2026-07-02-money-integrity.md`, `docs/audits/2026-07-15-money-integrity-audit.md`, `docs/audits/2026-08-30-variant-stock-drift.md`, `docs/plans/2026-07-20-refund-reversal-stuck-sweep.md`.

> **Status note (2026-09-02, #1166):** see the "Remediation status" table in
> `docs/audits/2026-09-02-adversarial-audit.md` for the authoritative per-finding fixed/open state
> — the P2 payment-create-replay finding below is already fixed (#1134); the P0 refund-reversal
> finding is not.

---

### [P0] refund-reversal-stuck-sweep re-fires reversals for orders `rollbackForPaymentFailure` already reversed inline — anonymous attacker inflates a merchant's inventory and erases coupon redemptions at will

- **Where:**
  - `apps/api/src/services/order.service.ts:1009-1122` (`rollbackForPaymentFailure` — restores inventory with `InventoryHistory.type: 'adjustment'` at :1058, decrements coupon `usageCount` at :1069-1074, marks the order `status: 'cancelled'` at :1107 — and never stamps `refundReversedAt`, never fires `order/refunded`)
  - `apps/api/src/lib/inngest/functions/refund-reversal-stuck-sweep.ts:84-98` (sweep selects `status IN ('cancelled','refunded') AND refundReversedAt IS NULL AND updatedAt` in a [10 min, 12 h] window, then re-sends `order/refunded` with `restoreInventory: true`)
  - `apps/api/src/lib/inngest/functions/order-refunded.ts:100-160` (restore-inventory step's idempotency marker is `inventoryHistory.type: 'return_stock'` — it does NOT see the rollback's `'adjustment'` row, so it increments stock a SECOND time), `:165-210` (reverse-coupon decrements `usageCount` a second time, floored at 0)
- **Attack (fully anonymous, no auth) — SUMMARY, reproduction trimmed 2026-09-02 (P0, still open; see `docs/audits/2026-09-02-adversarial-audit.md` P0-4 for current fix status):**
  a guest can drive `rollbackForPaymentFailure` (via a payment-create call naming an
  unconfigured provider) and then let the unrelated `refund-reversal-stuck-sweep` cron
  re-fire a reversal against the same order on a ~10-25 min delay, because the two paths
  use different idempotency markers (`'adjustment'` vs `'return_stock'`) and the rollback
  never stamps `refundReversedAt`. Looping this invents inventory and drains coupon
  `usageCount` with one request per cycle, no authentication required. Full request-level
  steps are recoverable from the fix commit for P0-4 once landed (`refundReversedAt` is
  stamped inside `rollbackForPaymentFailure`'s transaction) — the diff makes the exact
  before/after request sequence auditable without a live exploit recipe sitting in the tree.
- **Damage:** merchant's stock ledger inflated by +N per cycle → storefront shows stock that does not exist → oversell of physical goods, refund/reputation cost. Coupon `usageCount` drained → a `usageLimit`-capped coupon accepts more redemptions than the merchant configured (free discounts beyond the cap — customer money gain). This also fires **organically** on every legitimate failed payment-create (provider outage/misconfig) since PR #822 shipped — silent upward inventory drift with zero alert (the sweep logs a routine "re-sent" warn).
- **Evidence:** rollback marker mismatch — `order.service.ts:1055-1065` writes `type: 'adjustment'`, `reason: 'Order rollback — payment step failed'`; fanout checks only `type: 'return_stock'` (`order-refunded.ts:109-114`). Only writer of `refundReversedAt` is the fanout's `claim-reversed` step (`order-refunded.ts:405-409`; grep confirms no other writer). Blast: `accounting-post-refund-journal.ts:21` also consumes the re-sent `order/refunded` (no-op here since no sale journal was posted, but it rides every re-fire).
- **Why prior audits missed it:** `docs/plans/2026-07-20-refund-reversal-stuck-sweep.md` reasons explicitly about the two legitimate marker-absence cases (`restoreInventory:false`, `trackInventory:false`) and even warns a marker-based sweep "would invent stock that never existed" — but never mentions `rollbackForPaymentFailure` (grep: zero hits in docs/), the third class: _cancelled orders whose reversal already ran inline under a different marker type_. The PR's "Re-firing is safe — verified, not assumed" table verified idempotency against the fanout's own markers only.
- **Blast radius:** second entry point `apps/api/src/mcp/tools/order.tools.ts:242` (MCP `place_order` failure path calls the same rollback). Same defect class = any past or future code path that cancels an order after reversing inline without stamping `refundReversedAt`.
- **Fix:** stamp `refundReversedAt = now()` inside `rollbackForPaymentFailure`'s transaction (it IS the reversal), or write the `return_stock` + `coupon_reversed` markers there instead of bespoke ones. Either one-line class fix closes both entry points.

---

### [P1] ReturnService.complete has no item-level granularity — a partial return reverses the WHOLE order (manual path) or reverses NOTHING (gateway-partial path)

- **Where:** `apps/api/src/services/return.service.ts:367-437`; `apps/api/src/services/order.service.ts:1319-1355` (`applyRefundEffects` takes only `orderId` — no items); fanout `order-refunded.ts` restores `order.items` in full.
- **Attack (hostile customer, normal merchant operation):** customer with a delivered 3-item order (say 1 cheap + 2 expensive, bought with a coupon, via an affiliate link) files a return for ONLY the cheap item (`create` validates per-item qty but computes `refundAmount` for just that item, :172-179). Merchant completes it with `refundMethod: 'cash'`/`'manual'`:
  - `:431-433` — `applyRefundEffects(storeId, orderId)` fires the full `order/refunded` fanout: **inventory restored for ALL 3 items** (customer still has 2), **coupon usage reversed**, **affiliate commission on the whole order clawed back**, **customer's earned loyalty points for the whole order revoked**, **GL sale journal fully reversed** (`accounting-post-refund-journal`), and the customer is emailed "Refund issued" for `order.total` (fanout falls back to `order.total` when `refundedAmount` is 0, `order-refunded.ts:243-244`).
  - Conversely with `refundMethod: 'gateway'` on a partial amount: `PaymentService.refund` is partial (`isFullRefund` false → no internal `applyRefundEffects`), and `:431` **skips** the local call because `isGatewayRefund` — so the physically returned goods are never restored to inventory at all (stock understated → lost sales), and the comment at :425-430 ("we'd be calling it twice") is wrong for the partial case.
- **Damage:** merchant ledger corrupted in BOTH directions depending on refund method; affiliates underpaid on trivial partial returns; customers stripped of loyalty points they legitimately earned on kept items; accounting reverses revenue the merchant still keeps.
- **Evidence:** `applyRefundEffects(storeId, returnRequest.orderId)` — whole-order signature; `Return`/`ReturnItem` quantities never reach the fanout.
- **Why prior audits missed it:** 2026-07-15 money audit scoped `return.service.ts` but focused on the P2028-timeout question; the whole-order-vs-item mismatch predates and survived the fanout redesign.
- **Blast radius:** every consumer of `order/refunded` inherits the whole-order semantics (inventory, coupon, affiliate, loyalty, backorders, GL journal). Also: `create` (:159-167) doesn't check cumulative previously-returned quantity, so the same item can appear in multiple return requests (gateway double-refund is blocked by the payment claim, but manual/store-credit double-bookkeeping is not).
- **Fix:** thread the returned item list/quantities through `order/refunded` (partial-reversal event), or restrict `applyRefundEffects` on the return path to full returns and add an item-level restore for partial ones.

---

### [P2] `POST /payments/create` is replayable — each COD replay adds the COD fee to `order.total` again and creates another Payment row; online replays mint multiple live invoices for one order

> **FIXED — #1134.** `payment.routes.ts` now carries an existing-payment guard before creating a
> new Payment row.

- **Where:** `apps/api/src/routes/payment.routes.ts:196-330` (no existing-payment guard anywhere in the handler; COD fee re-added at :271-277 on every call; new `cod_pending` Payment row at :279-290). Online branch (:351-430) likewise creates a new provider invoice + Payment row per call.
- **Attack:** (a) guest posts `/payments/create {orderId, provider:'cod'}` k times → `order.total = original + k×codFee` and k `cod_pending` rows — order/ledger corrupted, customer over-collected at the door, loyalty later earned on the inflated total; a plain double-click does this to real customers. (b) two tabs / retries on an online provider → two live gateway invoices each for `order.total`; customer can pay BOTH; webhook #2 completes Payment #2 (`assertValidTransition(confirmed,'confirmed')` is a same-status no-op, `order-status-machine.ts:32`) — **double capture with no duplicate-payment detection or alert anywhere**, refund only if the customer complains.
- **Damage:** order-total corruption; undetected customer double-charge (chargeback/dispute risk lands on the merchant).
- **Why prior audits missed it:** 2026-07-17 untested-flows audit looked at payment flows for coverage, not replay; money audits focused on webhook idempotency (which is solid) — the CREATE side has no idempotency at all.
- **Blast radius:** `retryPayment` (`payment.factory.ts:1297+`) at least requires `status === 'failed'`; the create route has no such state gate. Checkout order creation itself also has no idempotency key (double-submit race → duplicate pending orders; see P3 below).
- **Fix:** guard create with "order already has a non-failed Payment → return the existing paymentUrl" (idempotent), and make the COD fee write conditional on no prior COD payment row (or store the fee on the Payment only).

---

### [P2] Refund-webhook branch still writes its idempotency key BEFORE the reversal dispatch (07-15 audit F3 — narrowed, not fixed)

> **FIXED — #1134.** `payment.factory.ts` now runs the reversal dispatch (`applyRefundEffects`) and
> the order-status flip BEFORE the durable idempotency-key write, per its own updated comment: "with
> effects-first, any failure leaves NO durable state, so the retry re-enters and re-runs the
> (idempotent) reversal dispatch." Line numbers below have since shifted.

- **Where:** `apps/api/src/services/payment-providers/payment.factory.ts:920-934` (no-op when `prevRefundStatus === newStatus`), `:937-955` (durable `metadata.refundStatus = newStatus` + `Payment.status='refunded'` write), `:1005` (`applyRefundEffects` — now an `inngest.send`), `:1008-1015` (order → `refunded` AFTER that).
- **Attack/trigger:** out-of-band MyFatoorah refund webhook arrives; the metadata write commits; `inngest.send` inside `applyRefundEffects` throws (Inngest event-API blip — exactly the outage class PR #822 exists for), or `assertValidTransition` at :992 throws. The Inngest step retry re-enters `handleWebhook`, hits the `prevRefundStatus === newStatus` no-op at :920, returns success → webhook marked `processed`, **no reversal ever enqueued, no dead-letter**. And because the order's status flip at :1008 also never ran, the order is NOT in (`cancelled`,`refunded`) — so `refund-reversal-stuck-sweep` (which keys on status) can never rescue it. Money went back to the customer at the provider; stock/coupon/affiliate/loyalty never reversed; silent.
- **Why prior audits missed it:** 07-15 audit F3 flagged exactly this; the fix shrank the failure window (heavy inline work → one `inngest.send`) but kept the write-marker-before-effect ordering, and the new sweep's status filter can't see this shape.
- **Fix:** set `metadata.refundStatus` (and the order flip) only AFTER `applyRefundEffects` succeeds, or key the no-op on a marker written by the fanout.

---

### [P2] Main webhook path mutates `Payment.status` before the order-transition assert — a completed payment on a terminal order is recorded but never reconciled

> **FIXED — #1134.** `payment.factory.ts` now asserts the order transition BEFORE the payment write,
> per its own updated comment citing this finding by name ("adversarial audit P2"), and
> `payment-reconcile-sweep.ts` was added to watch for the captured-on-cancelled shape. Line numbers
> below have since shifted.

- **Where:** `payment.factory.ts:1141-1153` (`payment.update({status: webhookData.status})`) runs before `:1184` (`assertValidTransition(payment.order.status, orderStatus)`).
- **Trigger:** a `completed` webhook for an order already `cancelled` (e.g. customer pays at the gateway in the race window around a cancel; the daily auto-cancel asks the provider first, but rollback-cancel and admin-cancel don't). The assert throws; Inngest retries 3× (each retry re-writes payment then re-throws), dead-letters — but the durable state is `Payment.status='completed'` + `Order.status='cancelled'`, money captured for a cancelled order, and no reconciler targets that combination.
- **Fix:** assert the order transition BEFORE the payment write (mirror `payment-confirm.service.ts:222-228`, which re-reads current status and asserts first), and add "completed payment on cancelled order" to a reconciliation sweep.
- Sibling: `order.routes.ts:1154-1158` (`refresh-refund-status`) writes `status:'refunded'` with no `assertValidTransition` — the only remaining unguarded `Order.status` writer (admin-gated).

---

### [P3] Manual "refunded" status still never touches the Payment row or `Order.paymentStatus` (open since 2026-07-02 audit F4)

- **Where:** `order.service.ts:1141-1160` (`updateStatus` writes only `status`/`deliveredAt`; grep confirms no `prisma.payment` in the file; `paymentStatus` untouched).
- **Damage:** admin status-button refund leaves `Order.paymentStatus='paid'`, `Payment.status='completed'`, `refundedAmount=0` forever — paid-revenue aggregates and the customers cache count refunded orders as paid. Third audit in a row to carry this.

### [P3] Checkout has no idempotency key — concurrent double-submit creates duplicate orders

- **Where:** `order.service.ts:301-309` (cart read outside the tx; two concurrent `create` calls both see the same items), `public.routes.ts:566-578`. Both orders decrement stock and reserve coupon usage; COD duplicates notify the merchant twice and ship twice if unnoticed; online duplicates sit until the DAILY 03:00 auto-cancel (`order-auto-cancel-unpaid.ts`) releases stock/coupon. Fix: idempotency key or a short-window unique constraint on (cartId → order).

### [P3] State machine allows fulfilling an unpaid order

- **Where:** `order-status-machine.ts:21` — `pending: ['confirmed','processing','shipped','delivered','cancelled']` with no payment gate in `updateStatus`. An admin can ship/deliver an unpaid online order; delivery then awards loyalty points and affiliate commission on an order that was never paid (`order-status-changed.ts:104-111`). Merchant footgun, not attacker-reachable.

### [P3] Guest identity is self-asserted for `firstOrderOnly` promotions and per-user coupon caps

- **Where:** `promotion-resolver.ts:58-75` (fresh email/phone ⇒ `isFirstOrder: true`), `order.service.ts:703-747` (per-user coupon cap keyed on the same fields; the code documents accepting this for coupons — the same hole applies to first-order automatic promotions, which the docs don't note). Store-wide `usageLimit` remains the only real cap; a promotion has no usage cap at all. Bound the exposure with promotion-level caps if first-order promos carry real value.

---

## FALSIFIED

1. **PR #822's safety claim** (`docs/plans/2026-07-20-refund-reversal-stuck-sweep.md` "Re-firing is safe — verified, not assumed"; scoped memory `project-fwb-refund-reversal-sweep`): the re-fire is NOT safe for rollback-cancelled orders — the sweep does to them exactly what the design doc warned a marker-based sweep would do ("invent stock that never existed"), via the marker-type mismatch (P0 above).
2. **2026-07-15 money audit's "F3 fix direction" as implemented**: the refund-webhook idempotency no-op is still keyed on a pre-effect durable write (`payment.factory.ts:920/937`); the window narrowed but the silent-loss retry shape survives, and the new sweep cannot see it (P2 above).
3. **ReturnService comment** (`return.service.ts:425-430` "doubling up is safe but wasteful"): for a partial gateway refund NEITHER path restores the returned items — the comment's premise (refund ran applyRefundEffects) holds only for full refunds (P1 above).

## UPHELD (attacked hard, could not break)

1. **Price authority.** Traced guest checkout end-to-end: cart lines carry NO price column (`cart.service.ts` — price read live from product/variant at every render), `OrderService.create` recomputes subtotal/tax/shipping/discounts entirely server-side (`order.service.ts:301-570`), `pointsToRedeem` is quoted server-side against real balance (`loyalty.service.ts computeRedemption`), `/payments/create` charges `order.total` (`payment.routes.ts:355`), `createAdminOrder` re-hydrates catalog prices and floors quantity/shippingOverride (`order.service.ts:1433-1477`, `order.routes.ts:1396`). No client-controlled number reaches an amount. Tried: variant-price confusion (fixed via `cartLineUnitPrice`), cross-store product/variant injection (scoped at `cart.service.ts:127-143`), negative quantities (Zod `int().min(1)`), area-zero shipping (AREA_NOT_DELIVERABLE guard).
2. **Webhook boundary.** Signature header required at the route (`webhook.routes.ts:19-55`), HMAC verified over the RAW body buffer, all four providers fail CLOSED on missing secret with timing-safe compare (`tap:202`, `myfatoorah:444`, `hesabe:222`, `upayments:216`), per-store secret resolved from the Payment row, 3-layer replay idempotency (WebhookEvent unique key + `Order.webhookProcessedAt` + status-equality no-ops), amount reconciliation holds underpaid orders with P0 alert (`payment.factory.ts:1041-1117`), and the PSP redirect is never trusted — `/verify-payment` pulls the provider's own status by the STORED transactionId (`public.routes.ts:674-860`). Pending payments are driven terminal by the daily auto-cancel reconciler that asks the provider before cancelling.
3. **Oversell + double-refund races.** Atomic conditional `UPDATE … WHERE inventory >= qty` inside the money tx (`inventory-decrement.ts`), atomic coupon reserve with limit guard (`order.service.ts:753-767`), atomic payment claim before the provider refund call with release-on-provider-error (`payment.factory.ts:671-700`) — the 07-02 F1 double-refund fix holds; a partial refund also permanently locks further gateway refunds (conservative, safe direction).
4. **Variant stock two-meanings fix (0abcb344).** Checkout, rollback, restore, and admin aggregates all touch exactly one row per line; `effective-inventory.ts` + `EFFECTIVE_STOCK_SELECT` cover the readers I checked; found no surviving variant-blind reader on the money path.

## BLIND SPOTS

- **Live DB evidence of the P0's organic drift** would settle its historical impact: `SELECT count(*) FROM inventory_history a JOIN inventory_history b ON a.reference=b.reference AND a.product_id=b.product_id WHERE a.type='adjustment' AND a.reason='Order rollback — payment step failed' AND b.type='return_stock';` (each row = one double-restored order since PR #822).
- Whether the four PSPs actually sign webhooks as HMAC-SHA256-of-raw-body with the configured secret — if not, real webhooks fail verification and everything rides the guest-verify pull path (availability, not integrity; needs a prod webhook log sample).
- Inngest delivery health in prod (the entire reversal chain + sweep assumes events land; `alerts-failure-watch` coverage verified in code only).
- Runtime behavior of Hesabe's `decrypt` on a garbage payload (throws before parse — handled as webhook failure; not verified live).
