# FWB Money-Integrity Deep Audit — 2026-07-02

READ-ONLY audit. Worktree `force-website-builder__fix-deep-audit-2026-07-02`, origin/main HEAD `2332c4d5`.
Lens: money integrity (representation, webhooks, transactions, idempotency, refund side-effects, append-only event log, billing feature-flag enforcement).

Legend: **CONFIRMED** = verified against current code; **PLAUSIBLE** = strong reasoning, exact runtime trigger not reproduced.

---

## What is already solid (skip / no action)

Verified good, so not raised as findings:

- **Money representation is integer minor-units (fils) end-to-end.** `Order.total/subtotal`, `OrderItem.price/costPrice/total`, `Payment.amount/refundedAmount`, `JournalLine.debit/credit`, `Expense.amount/total` are all Prisma `Int` (schema.prisma:694, 1071, 1229–1262, 2698–2700, 2998–3000). FX uses `Decimal @db.Decimal(16,8)` (JournalLine.fxRate:2707, Expense.fxRate). No float columns for money.
- **Float only appears at the provider display boundary** (`/1000` for KWD, `Math.round(x*1000)` back to fils) — `myfatoorah.provider.ts:300,377,434,522,547`, email/invoice templates. All conversions are `Math.round`-guarded; no `toFixed`/`parseFloat` mutates a stored money value (the `toFixed` hits are display strings; `parseFloat` in `xlsx-import.ts:284–299` is immediately `Math.round(*1000)`'d).
- **Interactive money transactions use `withMoneyTx`** (maxWait 10s / timeout 30s, `packages/database/src/with-money-tx.ts`) — mitigates the Neon-pooler P2028 2s-default trap.
- **Serializable cart writes have bounded P2034 retry** (`lib/db-retry.ts` `retryOnWriteConflict`, duck-typed on `.code`).
- **Journal idempotency uses Postgres SAVEPOINT** inside caller transactions (partial-index P2002 does not poison the outer tx).
- **Webhook HMAC is per-store + timing-safe** (`payment.factory.ts:751–791`, per-store secret resolved upfront via `resolveStoreIdFromWebhookPayload`), with a Redis-counter P0 alert on ≥3 failures.
- **Append-only `PaymentEvent` log** captures every create/webhook/refund with the raw provider payload (`recordPaymentEvent`, wired at all payment mutation sites).
- **Verify-on-return** is the primary confirmation path with a shared idempotent routine (`payment-confirm.service.ts`), and webhook processing is offloaded to Inngest with a 3-layer idempotency guard (route `order.webhookProcessedAt` + inbox `WebhookEvent.status` + handler internal no-ops).
- **`requireFeature()` billing gate is broadly applied** (156 route usages across accounting/inventory/whatsapp/etc.).

---

## Findings

### F1 — Concurrent "Refund via provider" can double-refund at the gateway (lost money)

**Severity: CRITICAL — CONFIRMED (race window)**

`PaymentService.refund` (`apps/api/src/services/payment-providers/payment.factory.ts:626–701`) does a **read-check-then-act with no lock and no atomic guard**:

```ts
const payment = await prisma.payment.findFirst({ where: { transactionId }, ... }); // read
if (payment.status !== 'completed') throw INVALID_STATE;                            // check (line 641)
const response = await provider.refund(request);                                   // ACT: real money leaves (line 647)
await prisma.$transaction([ payment.update({ status:'refunded', refundedAmount:{increment} }), ... ]); // write (line 663)
```

The `status==='completed'` guard is the ONLY double-refund protection, and it is read **outside** the transaction that later flips the status. Two overlapping invocations — an admin double-clicking the RefundButton, an admin + a retried request, or two staff on the same order — both read `status:'completed'`, both pass the guard, and both call `provider.refund()` **before** either writes `status:'refunded'`. Result: two `MakeRefund` calls to MyFatoorah/Tap → the customer is refunded twice, `refundedAmount` is incremented twice, and there is no provider-side undo (comment at line 657 acknowledges refunds are terminal).

**Adversarial scenario:** Order paid 10.000 KWD. Admin taps "Refund" twice within ~1s (slow network, no button-disable guarantee on the server side). Both requests hit the provider → 20.000 KWD leaves the merchant's balance for a 10.000 KWD order.

**Fix direction:** make the state check atomic — `updateMany({ where:{ id, status:'completed' }, data:{ status:'refunding' } })` and only call the provider when `count===1`; or wrap the check+provider-call behind a per-payment Redis lock / DB advisory lock. An idempotency key on the refund action would also close it.

---

### F2 — `applyRefundEffects` inventory restore is NOT idempotent (phantom stock / oversell)

**Severity: HIGH — CONFIRMED**

`OrderService.applyRefundEffects` (`apps/api/src/services/order.service.ts:1109–1162`) unconditionally `increment`s product + variant inventory and writes a `return_stock` `InventoryHistory` row **every time it is called**. There is no per-order guard (no "already restored" marker, no check that the order wasn't already refunded). The `track_inventory` filter (line 1136) only selects WHICH products restore — it is not an idempotency guard, despite the project memory claiming it is.

Nothing in the function prevents a second execution for the same order. Two real convergence paths trigger it twice:

**Scenario A (status transition):** an order is refunded (`updateStatus('refunded')` → `applyRefundEffects`, order.service.ts:878–887), then later moved to `cancelled` in the admin status menu → `updateStatus('cancelled')` also matches `status==='cancelled' || 'refunded'` and calls `applyRefundEffects` **again**. Inventory is incremented a second time → phantom stock → subsequent oversell.

**Scenario B (manual-refund + out-of-band webhook, see F4):** manual `updateStatus('refunded')` restores inventory but does NOT flip `Payment.status` to `refunded`. When MyFatoorah's `RefundStatusChanged=Refunded` webhook later arrives, the out-of-band guard `wasAlreadyHandled = payment.status==='refunded'||'partially_refunded'` (payment.factory.ts:928–930) evaluates **false**, so it fires `applyRefundEffects` a second time (payment.factory.ts:935). Double inventory restore + double coupon decrement.

**Adversarial scenario:** merchant sells the last 5 units, refunds the order (stock → 5), then cancels the now-refunded order for bookkeeping → stock shows 10. Five customers buy phantom units the merchant cannot ship.

**Fix direction:** gate the inventory-restore block on an idempotency marker (e.g. `Order.inventoryRestoredAt`, or existence of a `return_stock` InventoryHistory row referencing this orderId) inside the `FOR UPDATE` transaction.

---

### F3 — No paid-amount reconciliation against order total (underpayment marks order paid)

**Severity: HIGH — CONFIRMED (missing control)**

Both confirmation paths flip the order to `paid`/`confirmed` purely on the provider's _status string_, never comparing the _paid amount_ to `order.total`:

- Webhook: `PaymentService.handleWebhook` (payment.factory.ts:963–1024) maps `webhookData.status==='completed'` → `orderStatus='confirmed', orderPaymentStatus='paid'`. `webhookData.amount` (the provider-reported paid amount) is written into `metadata.paidAmount` (line 990) but **never compared** to `payment.amount` / `order.total`.
- Verify-on-return: `confirmPaymentFromProviderStatus` (payment-confirm.service.ts:100–124) flips to paid on `providerStatus.status==='completed'` with no amount check.

If a provider ever reports `Paid` for a partial capture, a currency-mismatched amount, or a tampered/mis-configured hosted-page total, FWB records the order as fully paid and fans out fulfilment (`order/created` → picking, notifications, accounting `recordSale`). The `Payment.amount` we created and the amount the customer actually paid are never reconciled.

**Adversarial scenario:** a MyFatoorah invoice is created for 10.000 KWD but (via a provider mis-config, reused invoice, or gateway edge case) settles for 1.000 KWD. The `InvoiceStatus:Paid` webhook marks the order fully paid and ships it. Merchant loses 9.000 KWD of goods.

**Fix direction:** in both paths, when the provider returns a paid amount, assert `paidAmount >= payment.amount` (allowing a small rounding tolerance) before transitioning to `paid`; on mismatch, hold the order in a `payment_review` state and fire a P0 alert rather than confirming.

---

### F4 — Manual `updateStatus('refunded')` never updates `Payment.status` (row inconsistency + breaks webhook idempotency)

**Severity: MEDIUM — CONFIRMED**

`OrderService.updateStatus` (order.service.ts:~820–887) writes `Order.status`, an `OrderEvent`, and runs `applyRefundEffects`, but it **does not touch the `Payment` row**. After a manual "Refunded", the order shows `status:refunded` while its `Payment.status` is still `completed` and `refundedAmount` is still `0`.

Consequences:

1. **Data integrity:** the append-only `PaymentEvent` log and `Payment` row disagree with the order — a dispute-time reconciliation reads a `completed` payment on a refunded order.
2. **It is the root cause of F2 Scenario B:** the webhook out-of-band guard keys on `Payment.status`, which manual refund left as `completed`, so the guard misfires and double-applies effects.

**Fix direction:** manual-refund status changes should also flip the linked Payment row to `refunded` (and set `refundedAmount`) in the same transaction, so every "is this already refunded?" guard (webhook, admin button visibility) reads a consistent signal.

---

### F5 — Order creation has no idempotency key (double-submit → duplicate order + duplicate payment)

**Severity: MEDIUM — PLAUSIBLE**

`POST /public/orders` (`apps/api/src/routes/public.routes.ts:470–508`) and `OrderService.create` (order.service.ts:378) accept no `Idempotency-Key` and do no dedupe on `(sessionId, cartHash)`. Double-protection relies solely on the cart being consumed (`tx.cartItem.deleteMany`, order.service.ts:595) inside the transaction.

Two near-simultaneous submits (double-tap on a slow "Place order" button, client auto-retry on a timed-out-but-succeeded request) each read the live cart, each pass the atomic inventory decrement (which correctly prevents oversell), each create a distinct `Order`, and each clear the cart. Outcome: **two orders for one cart**, double inventory decrement, and two payment sessions can be minted (`POST /payments/create` per order) → the customer may be charged for both.

Note the webhook path is well-guarded (`Order.idempotencyKey` + `WebhookEvent`), but that only dedupes _webhooks for an existing order_; it does not dedupe _order creation itself_.

**Adversarial scenario:** flaky mobile connection; the create request succeeds server-side but the client sees a timeout and retries. Two orders exist; the shopper pays the second, the first sits `pending` and (worse) also decremented stock.

**Fix direction:** accept a client-supplied `Idempotency-Key` (or hash `sessionId + sorted cart line items`) and short-circuit-return the existing order on a repeat within a TTL window.

---

### F6 — `refund()` `refundedAmount` increment + coupon decrement are non-idempotent

**Severity: LOW–MEDIUM — PLAUSIBLE**

Downstream of the F1 race (or any repeated refund call that slips the status guard):

- `payment.factory.ts:669` does `refundedAmount: { increment: request.amount || payment.amount }` — a second execution over-counts the refunded total (financial-report inaccuracy, not direct cash loss).
- `applyRefundEffects` coupon reversal (order.service.ts:1164–1171) uses `updateMany({ where:{ usageCount:{ gt:0 } }, data:{ usageCount:{ decrement:1 } } })`. The `gt:0` floor only prevents going below zero on a single call; two calls decrement twice, so a coupon shared across many orders loses redemptions it should still count. (Loyalty and affiliate reversals ARE tagged-idempotent — this gap is specific to coupon + refundedAmount.)

**Fix direction:** resolved for free once F1/F2 are made idempotent (single-execution guarantee). Independently, coupon reversal could key on a per-order marker.

---

### F7 — Partial-refund path skips all side-effects by design — verify it is intended for the WAC/COGS ledger

**Severity: LOW — PLAUSIBLE (design confirmation needed)**

`PaymentService.refund` only runs `applyRefundEffects` when `isFullRefund` (payment.factory.ts:709). Partial refunds intentionally keep inventory deducted and commission earned (comment lines 703–708). That is defensible for physical goods, but the **accounting module is not reconciled**: a partial refund moves real money at the provider and increments `Payment.refundedAmount`, yet no `JournalEntry`/`recordRefund` is posted for the partial amount (the `order/refunded` Inngest fanout that drives accounting only fires from `applyRefundEffects`, which the partial path skips). Confirm whether partial refunds are expected to hit the ledger; if so, the COGS/cash journal will drift on every partial refund.

**Fix direction:** if partial refunds should be booked, post a partial `recordRefund` journal entry from the `refund()` path regardless of `isFullRefund`.

---

## Ranked summary

| #   | Severity | Status    | Defect                                                                                                                                                                   | Key location                                                                           |
| --- | -------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| F1  | CRITICAL | CONFIRMED | Concurrent "Refund via provider" both pass the `status==='completed'` check outside the tx → double `MakeRefund` at gateway → refunded twice                             | `payment.factory.ts:626–701` (check 641, provider call 647)                            |
| F2  | HIGH     | CONFIRMED | `applyRefundEffects` inventory restore has no per-order idempotency guard → double restore via refunded→cancelled or manual-refund+webhook → phantom stock/oversell      | `order.service.ts:1109–1162`; `order.service.ts:878–887`; `payment.factory.ts:928–954` |
| F3  | HIGH     | CONFIRMED | No reconciliation of provider paid-amount vs `order.total`; order marked paid on status string alone → underpayment/mismatch ships goods                                 | `payment.factory.ts:963–1024` (paidAmount 990); `payment-confirm.service.ts:100–124`   |
| F4  | MEDIUM   | CONFIRMED | Manual `updateStatus('refunded')` never flips `Payment.status`/`refundedAmount` → row inconsistency + defeats webhook out-of-band idempotency guard (root cause of F2-B) | `order.service.ts:820–887`                                                             |
| F5  | MEDIUM   | PLAUSIBLE | Order create has no idempotency key → double-submit creates 2 orders + 2 payment sessions for one cart                                                                   | `public.routes.ts:470–508`; `order.service.ts:378`                                     |
| F6  | LOW–MED  | PLAUSIBLE | `refundedAmount` increment + coupon `usageCount` decrement over-apply on any repeated refund call                                                                        | `payment.factory.ts:669`; `order.service.ts:1164–1171`                                 |
| F7  | LOW      | PLAUSIBLE | Partial refunds skip `applyRefundEffects` → no accounting/COGS journal for the partial cash movement                                                                     | `payment.factory.ts:703–709`                                                           |

**Counts:** Critical 1 · High 2 · Medium 2 · Low/Low-Med 2 — total 7 findings (5 CONFIRMED, 2 PLAUSIBLE).

Common root theme: FWB's refund/payment guards are **status-comparison checks read outside the mutating transaction**, and `applyRefundEffects` was designed to be "idempotent via upstream status gating" rather than idempotent in itself. Under concurrency (F1, F5) or multi-path convergence (F2, F4) those guards are not atomic, so money-side effects can double-apply. Making each money action single-execution (atomic conditional update / idempotency key / per-order restore marker) closes F1, F2, F5, and F6 together.
