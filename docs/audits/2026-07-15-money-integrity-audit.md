# FWB Money-Integrity Audit — 2026-07-15

READ-ONLY audit. No source modified. Scope: order/payment/refund integrity — `apps/api/src/services/order.service.ts`, `payment-providers/payment.factory.ts`, `affiliate.service.ts`, `loyalty.service.ts`, `with-money-tx.ts`, the payment-webhook Inngest pipeline, `order-refund-gating.ts`, `return.service.ts`, `accounting/backorder.service.ts`.

Legend: **CONFIRMED** = verified by reading the current code end-to-end. **PLAUSIBLE** = strong reasoning from confirmed code, exact runtime trigger not reproduced.

Cross-referenced against `docs/audits/2026-07-02-money-integrity.md` (prior deep audit, F1–F7) and `docs/audits/2026-07-09-async-orchestration-audit.md` (E1–E3, Inngest reliability). This audit's job is to trace the money-correctness consequences of the **known** production bug — `applyRefundEffects` exceeding the 30s `withMoneyTx` budget (P2028) on refund/cancel — not just re-flag it.

`graphify-out/GRAPH_REPORT.md` was checked; it does not carry money-integrity-specific findings beyond generic node listings, so this audit reads the source directly (per its own recommendation when the graph has no relevant slice).

---

## Answer to Q1 — what state does a mid-transaction P2028 timeout leave the order in?

**Short answer: `Order.status` (and usually `Payment.status`) are already durably committed to `'refunded'`/`'cancelled'` in a _separate, earlier_ write — before `applyRefundEffects` ever runs — and are never rolled back by its later failure. Inside `applyRefundEffects` itself, the inventory-restore + `refund_effects_applied` marker share one Postgres transaction, so a timeout there is atomic (nothing partial commits from that inner block). But once the order shows `refunded`, none of the three places that could retry the missing reversals (coupon decrement, affiliate reversal, loyalty reversal, backorder cancel, "Refund issued" notification) can actually do so — the retry paths are all structurally blocked. The order is left in a durably INCONSISTENT state: status says refunded, but the money/inventory/commission/points side of the ledger was never touched, with no automatic path back to consistency.**

Trace, in order:

1. **`OrderService.updateStatus`** (`order.service.ts:938-947`) writes `Order.status = 'refunded'` via its own `prisma.order.update(...)` call and commits it **before** `applyRefundEffects` is invoked at `order.service.ts:1007`. If `applyRefundEffects` then throws P2028, this status write is not touched — it's a different DB round-trip, already committed.
2. **Inside `applyRefundEffects`** (`order.service.ts:1127-1202`), the inventory restore loop and the `refund_effects_applied` `OrderEvent` marker (`toStatus: 'refund_effects_applied'`) both live inside one `withMoneyTx` call. If that transaction times out at 30s, Postgres never issues `COMMIT`, so this part is genuinely atomic — no half-restored inventory, no marker written. Good news, but narrow: it only protects that one block.
3. **Everything after the transaction — coupon `usageCount` decrement (`:1217-1228`), affiliate reversal (`:1231-1238`), loyalty earn-reversal (`:1244-1249`), loyalty redeem-recredit (`:1254-1259`), the `order/refunded` notification (`:1267-1273`), backorder auto-cancel (`:1278-1285`) — runs on the bare `prisma` client, NOT inside the timed-out transaction, and NEVER RUNS AT ALL if the transaction itself is what threw** (the function throws before reaching that code). So on a timeout specifically inside the `withMoneyTx` call, none of these six effects execute.
4. **The throw propagates out of `updateStatus`, out of the route handler, to `next(error)` → HTTP 500** (`order.routes.ts:535-537`). The admin sees a failed request, but `Order.status` is already `'refunded'` in the DB (step 1). Re-reading the order shows `refunded` even though the "request failed."
5. **The admin cannot retry via the same endpoint.** `updateStatus`'s `validTransitions` map (`order.service.ts:913-921`) has `refunded: []` — refunded is terminal, including refunded→refunded. A second `PUT /orders/:id/status {status:'refunded'}` throws `INVALID_STATUS_TRANSITION` (400) without ever reaching `applyRefundEffects` again.
6. **The webhook out-of-band-refund retry path is also blocked**, because `updateStatus` never touches `Payment.status` (confirmed by `grep -n "payment.update\|prisma.payment" order.service.ts` → zero hits). If, separately, the admin used **refund-via-provider** instead of the manual status button, `Payment.status` WAS already flipped to `'refunded'` in the same atomic `$transaction` as `Order.status` (`payment.factory.ts:704-728`) — i.e., _before_ `applyRefundEffects` runs at line 760. The webhook handler's own out-of-band guard (`payment.factory.ts:972-973`, `wasAlreadyHandled = payment.status === 'refunded' || 'partially_refunded'`) will then be `true` when the real provider webhook later arrives, so it explicitly **skips** re-running `applyRefundEffects` (`:974`). The one mechanism designed to self-heal a missed reversal treats "already marked refunded" as "already handled," which is false when the marking happened but the handling didn't.
7. **The only manual escape hatch is `POST /orders/:orderId/refresh-refund-status`**, but its trigger condition (`order.routes.ts:1099-1100`, `needsSideEffects = ... && payment.status === 'completed'`) requires `Payment.status` to STILL be `'completed'` — which is only true for the manual-`updateStatus` path (where `Payment.status` is never touched at all, F5 below), not for the refund-via-provider or webhook paths (both flip `Payment.status` to `'refunded'` atomically alongside `Order.status`, before the reversal effects even attempt to run).

**Net effect:** depending on which of the three refund entry points hit the timeout, the order is stuck showing `refunded`/`cancelled` while affiliate commission is still owed, loyalty points are still on the customer's balance (both earned-not-reversed and redeemed-not-recredited), the coupon's usage count is still consumed, open backorder lines are still open, and the merchant/customer never got the "Refund issued" notification — **permanently**, until someone manually intervenes at the DB/Prisma-Studio level (or files an ad-hoc `Return` record via `ReturnService`, an undocumented, item-level workaround not designed for this purpose — see F1 below). This is a real money-loss risk (affiliate overpay, uncredited loyalty liability) dressed up as "the order says refunded, so it must be fine."

---

## Findings

### F1 — CRITICAL — CONFIRMED — No retry path exists once `Order.status`/`Payment.status` flip to `refunded`; a P2028 mid-`applyRefundEffects` timeout is a silent, permanent partial-refund

Covered in full in the Q1 trace above. Root cause: the code optimistically commits the _terminal_ status (`refunded`) in a step separate from — and prior to — the step that actually performs the reversals, and every retry surface (`updateStatus`'s state machine, the webhook `wasAlreadyHandled` guard, `refresh-refund-status`'s `payment.status==='completed'` gate) was built assuming "status says refunded" implies "reversals ran," which the P2028 timeout falsifies.

**Money impact:** affiliate commission not reversed (merchant overpays an affiliate on revenue that was refunded), loyalty points not reversed (customer keeps points/discount value for merchandise they returned), coupon usage count not restored (blocks a legitimate customer from a redemption they're entitled to), backorder lines left open (purchase-order demand planning drifts).

**Fix direction:** make "genuinely refunded" observable independently of `Order.status`/`Payment.status` — e.g. a `refundEffectsAppliedAt` column read by all three retry surfaces instead of (or in addition to) the terminal status string, and allow `updateStatus`'s `refunded → refunded` transition specifically when that column is null (an explicit "re-run reversal" affordance), or move `applyRefundEffects` itself onto a retriable Inngest step with its own dead-letter alert instead of running inline inside the synchronous request path.

---

### F2 — CRITICAL — CONFIRMED — Admin "refund via provider" swallows a P2028 (or any) `applyRefundEffects` failure and returns HTTP 200 success

`payment.factory.ts:753-775`:

```ts
if (isFullRefund) {
  const order = await prisma.order.findUnique({ where: { id: payment.orderId }, select: { storeId: true } });
  if (order) {
    try {
      await OrderService.applyRefundEffects(order.storeId, payment.orderId);
    } catch (effectsError) {
      // Non-fatal: provider refund already succeeded and the order is marked refunded.
      logger.error({ err: effectsError, ... }, '[PAYMENT] applyRefundEffects failed after refund — inventory/coupon/commission may be inconsistent');
    }
  }
}
return response;   // <-- always success, regardless of the catch above
```

This is the admin-facing "Refund via provider" button (`POST /orders/:orderId/refund-via-provider`, `order.routes.ts:1178+`). Unlike F1's `updateStatus` path (which at least surfaces a 500), this path is entirely synchronous — no Inngest step, no retry, no dead-letter alert — and the failure is caught and merely logged. The admin's UI shows a successful refund with zero indication anything is wrong. This is the worst of the three entry points precisely because it has no failure signal at all.

**Fix direction:** at minimum, surface the `applyRefundEffects` failure in the response (`success:true, warning:'reversal_incomplete'`) so the admin UI can flag it, and/or route this call through the same retriable-Inngest-step pattern the webhook path uses.

---

### F3 — CRITICAL — CONFIRMED — The one path explicitly designed to be "safe to retry" is retry-defeated by its own idempotency check, and fails silently (no throw, no alert) on the second attempt

`payment.factory.ts:905-943` (refund-webhook branch of `handleWebhook`, which runs inside the retriable `payment-webhook-process` Inngest step — `retries: 3`, dead-letters via `alerts-failure-watch`):

```ts
// line 911: idempotent no-op check
if (prevRefundStatus === newStatus) { ...; return { success: true, ... }; }

// lines 926-943: durably writes BEFORE applyRefundEffects runs
await prisma.payment.update({
  where: { id: payment.id },
  data: {
    metadata: { ...prevMeta, refundStatus: newStatus, ... },
    ...(newStatus === 'completed' && payment.status !== 'refunded'
      ? { status: 'refunded' as const, refundedAmount: webhookData.refund.amount ?? 0 }
      : {}),
  },
});
// ... recordPaymentEvent ...

// line 972-986
const wasAlreadyHandled = payment.status === 'refunded' || payment.status === 'partially_refunded';
if (newStatus === 'completed' && !wasAlreadyHandled && payment.order) {
  // comment: "Safe to retry: applyRefundEffects is idempotent ... Let a genuine
  // failure propagate ... gives 3 retries + alerts-failure-watch P0 dead-letter"
  await OrderService.applyRefundEffects(payment.order.storeId, payment.orderId);
  ...
}
```

Trace a P2028 here:

1. First Inngest attempt: `prisma.payment.update` durably sets `metadata.refundStatus = newStatus` **and** `Payment.status = 'refunded'` (line 939-941, `payment.status !== 'refunded'` was true going in). This commits regardless of what happens next — it's a standalone write, not inside `applyRefundEffects`'s transaction.
2. `applyRefundEffects` is called (line 986) and times out (P2028). It throws. The `step.run('process', ...)` in `payment-webhook-process.ts:123` throws too, and Inngest schedules a retry (per the code's own comment, this is the intended behavior).
3. **Second Inngest attempt re-runs `handleWebhook` from the top.** `prevRefundStatus` is now read fresh from `Payment.metadata.refundStatus`, which the FIRST attempt already durably set to `newStatus`. Line 911's check `prevRefundStatus === newStatus` is now **true** → the function hits the early no-op return (`'refund event matches stored status — no-op'`) and returns `{ success: true, ... }` **without ever calling `applyRefundEffects` again**.
4. The Inngest step "succeeds" on retry #2. `payment-webhook-process`'s `finalize` step marks the `WebhookEvent` row `status: 'processed'`. **No exception ever reaches `alerts-failure-watch`.** The reversal is permanently lost with zero alerting — a strictly worse outcome than a function that fails loudly forever, because nothing ever pages an operator.

The comment at line 984 ("Safe to retry ... idempotent") is true about `applyRefundEffects`'s own internal markers (double-application is indeed prevented) but false about the _composition_ with the metadata write that precedes it — the retry never reaches the call it's supposedly safe to retry.

**Fix direction:** write `Payment.metadata.refundStatus`/`Payment.status` and run `applyRefundEffects` in a single unit — e.g. move the metadata write to AFTER `applyRefundEffects` succeeds, or gate the idempotency no-op on a marker that's only set once `applyRefundEffects` itself has completed (mirroring the pattern `applyRefundEffects` already uses correctly for its own two markers).

---

### F4 — HIGH — CONFIRMED — Coupon `usageCount` reversal marker is written BEFORE the effect it guards, in a separate step — a transient failure permanently skips the reversal on every future call

`order.service.ts`: the `refund_effects_applied` `OrderEvent` marker is written **inside** `withMoneyTx` (`:1187-1198`), but the coupon decrement it's meant to gate runs **after** the transaction commits, on the bare `prisma` client, uncaught (unlike the affiliate/loyalty reversals a few lines below, which are wrapped in `.catch()`):

```ts
// :1127-1202 — inside withMoneyTx, commits atomically:
if (!alreadyAppliedEffects) {
  await tx.orderEvent.create({ data: { ..., toStatus: 'refund_effects_applied', ... } });
}
return { alreadyRestoredInventory, alreadyAppliedEffects };
// tx committed here — marker is now durably true for THIS order, forever

// :1217-1228 — AFTER the tx, using the OLD (pre-write) value of alreadyAppliedEffects
// for THIS call, but any future call re-reads the marker and finds it TRUE:
if (!alreadyAppliedEffects && order.couponCode) {
  await prisma.coupon.updateMany({
    where: { storeId, code: order.couponCode, usageCount: { gt: 0 } },
    data: { usageCount: { decrement: 1 } },
  });   // <-- not wrapped in try/catch; a throw here propagates out of applyRefundEffects
}
```

If this `updateMany` throws (transient connection error, brief Neon pooler hiccup, or the enclosing call is P2028-timed-out for an unrelated reason on a retry that reaches this far), the exception propagates out of `applyRefundEffects`. Any **subsequent** call for the same order — even one that would otherwise succeed cleanly — reads `alreadyAppliedEffects: true` from the DB (the marker already committed on the first call) and **permanently skips** the coupon decrement. This is the mirror image of the double-apply risk the code's own doc-comment (`:1085-1109`) is defending against — the marker-before-effect ordering instead produces a silent, permanent **under**-application. `usageCount` for that coupon is inflated forever, silently blocking future legitimate redemptions.

**Fix direction:** write the `refund_effects_applied` marker only after ALL of its guarded effects (including the coupon decrement) have completed, or split it into a dedicated `coupon_reversed` marker written in the same transaction as the `coupon.updateMany` call.

---

### F5 — MEDIUM — CONFIRMED, still open from 2026-07-02 audit F4 — Manual `updateStatus('refunded')` never touches `Payment.status`

`grep -n "payment.update\|prisma.payment\|tx.payment" apps/api/src/services/order.service.ts` returns zero hits. The admin `PUT /orders/:id/status {status:'refunded'}` path flips `Order.status` and runs `applyRefundEffects`, but the linked `Payment` row's `status` stays `'completed'` and `refundedAmount` stays `0` indefinitely. This is the exact F4 finding from `2026-07-02-money-integrity.md` — unresolved as of this audit. It is also, incidentally, the reason `refresh-refund-status`'s recovery condition (F1's escape hatch, step 7 above) can ever trigger at all — but only for this one entry point, and only coincidentally (a merchant would have to know to click "Refresh refund status" and the provider would have to independently confirm a refund that may never have actually been issued through the provider for a manual/bookkeeping-only status change).

**Fix direction:** unchanged from the prior audit — flip the linked `Payment` row to `refunded` (with `refundedAmount`) in the same call as the `Order.status` write inside `updateStatus`.

---

### F6 — HIGH — CONFIRMED — Order state machine (`validTransitions`) is enforced ONLY on the admin `PUT /orders/:id/status` route; every gateway/webhook-driven order-status write bypasses it entirely

Three call sites write `Order.status` directly via `prisma.order.update(...)`, none of which check the order's current status or route through `OrderService.updateStatus`'s `validTransitions` map (`order.service.ts:913-921`):

- `payment.factory.ts:1158-1165` — the main "completed"/"failed"/"expired"/"cancelled" webhook path, unconditionally sets `order.status = orderStatus` (`'confirmed'` or unchanged `'pending'`) with no check of what the order's status currently is.
- `payment.factory.ts:704-728` (`PaymentService.refund`) — sets `order.status = 'refunded'` unconditionally for a full refund, bypassing `updateStatus` (and therefore its transition validation) entirely.
- `payment.factory.ts:989-993` — the out-of-band-refund webhook path — same unconditional `status: 'refunded'` write.

Because none of these gate on the order's current status, a stale, duplicate, or out-of-order webhook delivery can silently regress `Order.status` — e.g. a late "completed" webhook arriving after the order has already been manually `cancelled` or `delivered` would flip it back to `'confirmed'` with no validation and no rejection. `validTransitions` gives the _appearance_ of a state machine, but it only governs one of the four writers of `Order.status`.

**Fix direction:** funnel all `Order.status` writes — including the webhook-driven ones — through a single status-transition function that checks `validTransitions` (or an explicitly webhook-aware superset of it) before writing, rather than three independent `prisma.order.update` call sites with no shared validation.

---

### F7 — MEDIUM — CONFIRMED — Append-only `OrderEvent` audit trail has coverage gaps: webhook/gateway-driven status writes never create an `OrderEvent` row

`OrderEvent.create` for a status transition happens in exactly one place: `OrderService.updateStatus` (`order.service.ts:960-969`), wrapped in try/catch and best-effort. The three webhook/gateway call sites identified in F6 (`payment.factory.ts:1158-1165`, `:704-728`, `:989-993`) mutate `Order.status` directly and never write an `OrderEvent`. Per the 2026-07-09 async-orchestration audit (E1-2), online-payment orders' _first_ confirmed transition happens exclusively via the webhook path — meaning the append-only audit trail is systematically missing the paid→confirmed transition for every non-COD order, and missing refunded transitions for both the admin-refund-via-provider path and the out-of-band webhook path. A dispute-time reconstruction from `OrderEvent` alone would show gaps at exactly the money-relevant transitions.

**Fix direction:** write an `OrderEvent` row from the same three call sites identified in F6 (ideally as part of the F6 fix — a single funneled writer naturally logs once, centrally).

---

### F8 — LOW–MEDIUM — PLAUSIBLE — `refresh-refund-status`'s recovery precondition is unreachable for the two most common refund entry points

As traced in Q1 step 7: `needsSideEffects` (`order.routes.ts:1099-1100`) requires `payment.status === 'completed'`. Both `PaymentService.refund` (F1/F2's admin refund-via-provider path) and the out-of-band webhook path flip `Payment.status` to `'refunded'` in the SAME operation that flips `Order.status`, before `applyRefundEffects` is even attempted — so by the time a P2028 could strand the reversals, `Payment.status` is already `'refunded'`, and this endpoint's precondition is already false. It only functions as a recovery path for F5's manual-`updateStatus` case, where `Payment.status` happens to be left untouched.

**Fix direction:** resolved for free once F1 is fixed (a dedicated `refundEffectsAppliedAt` signal, independent of `Payment.status`/`Order.status`, would let this endpoint retry correctly regardless of entry point).

---

## What's already solid / fixed since 2026-07-02

Verified good on this pass — not re-flagged:

- **Old F1 (concurrent refund double-refund at the gateway) — FIXED.** `PaymentService.refund` now atomically claims the payment via `updateMany({ where: { status: 'completed' }, data: { status: claimedStatus } })` (`payment.factory.ts:661-671`) before calling the provider, with claim-release back to `'completed'` on a provider error (`:678-693`) so a legitimate retry after a failed provider call isn't stuck.
- **Old F3 (no paid-amount reconciliation) — FIXED.** `isAmountUnderpaid` (`payment.factory.ts:1008-1099`) compares `webhookData.amount` against `payment.amount` (5-fils tolerance), holds the order unpaid, records the mismatch, and fires a P0 alert rather than confirming a short payment.
- **Old F2 (inventory-restore non-idempotent) — FIXED.** `applyRefundEffects` now carries two explicit markers (`return_stock` `InventoryHistory` row + `refund_effects_applied` `OrderEvent` row), both read/written inside the same `FOR UPDATE`-locked transaction, correctly preventing double-restore across the refunded→cancelled and manual+webhook convergence paths the prior audit flagged. (F4 above is a NEW, narrower gap in this same rework — the coupon-decrement guard specifically, not the inventory restore.)
- **Loyalty reversal functions (`reverseEarnedPointsFromOrder`, `reverseRedeemedPointsFromOrder`) are correctly idempotent** — each writes its tagged `adjust`/`redeem-recredit` marker in the SAME `prisma.$transaction` as the balance mutation (`loyalty.service.ts:570-606`, `:779+`).
- **Affiliate `reverseCommission` is correctly idempotent** — the `status: 'refunded'` marker and the `totalEarned`/`pendingBalance` decrements are in the same `prisma.$transaction` (`affiliate.service.ts:561-573`).
- **Checkout inventory decrement is oversell-safe** — atomic conditional `UPDATE ... WHERE inventory >= qty` inside `withMoneyTx` (`order.service.ts:436-494`), no `SELECT ... FOR UPDATE` held across the transaction; a losing concurrent writer sees 0 rows affected, not a race.

  > **FALSIFIED 2026-09-02** — this verified ONE writer and asserted it as a
  > SYSTEM property. A sibling writer used a different (unfloored) helper
  > that decremented the PARENT product instead of the variant on variant
  > sales, outside this guarded path — production reached inventory = −16
  > six weeks later. Root cause and fix: `docs/audits/2026-08-30-variant-stock-drift.md`.
  > See the FALSIFIED entry in `docs/audits/_slices/2026-09-02-adversarial/falsification.md`
  > for the full account.

- **Webhook signature verification, durable inbox, and 3-layer idempotency remain solid** (`webhook.routes.ts` — `verifyWebhookSignature` before `recordInboundWebhook`, `checkIdempotency`, and `Order.webhookProcessedAt`), and the previously-flagged missing admin UI for `WebhookEvent` (2026-07-09 audit, E3-4) is now present at `apps/admin/src/app/webhook-events`.

---

## Ranked summary

| #   | Severity     | Status                                  | Defect                                                                                                                                                                                                                                                                                                                                            | Key location                                                                  |
| --- | ------------ | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| F1  | **CRITICAL** | CONFIRMED                               | P2028 timeout inside `applyRefundEffects` leaves `Order.status`/`Payment.status` already committed as refunded with NO automatic retry path for the missing reversals (coupon/affiliate/loyalty/backorder/notification) — permanently stuck                                                                                                       | `order.service.ts:938-947,1007,913-921`; `payment.factory.ts:972-974`         |
| F2  | **CRITICAL** | CONFIRMED                               | Admin "refund via provider" swallows `applyRefundEffects` failure and returns HTTP 200 success with zero signal to the operator; no retry surface at all (synchronous, not an Inngest step)                                                                                                                                                       | `payment.factory.ts:753-775`                                                  |
| F3  | **CRITICAL** | CONFIRMED                               | The refund-webhook branch's own idempotency check (`prevRefundStatus === newStatus`) is satisfied by a durable write that happens BEFORE `applyRefundEffects` runs, so an Inngest retry after a P2028 silently no-ops instead of re-attempting the reversal — the one path documented as "safe to retry" never actually retries, and never alerts | `payment.factory.ts:905-943,972-986`                                          |
| F4  | HIGH         | CONFIRMED                               | Coupon `usageCount` reversal marker (`refund_effects_applied`) is written INSIDE the transaction, before the coupon decrement that runs AFTER it (uncaught) — a transient coupon-decrement failure permanently skips the reversal on every future call                                                                                            | `order.service.ts:1187-1198,1217-1228`                                        |
| F5  | MEDIUM       | CONFIRMED (unresolved since 2026-07-02) | Manual `updateStatus('refunded')` never flips `Payment.status`/`refundedAmount` — row inconsistency persists indefinitely                                                                                                                                                                                                                         | `order.service.ts` (no `payment.update` call in the file)                     |
| F6  | HIGH         | CONFIRMED                               | Order state machine (`validTransitions`) only governs the admin route; 3 webhook/gateway call sites write `Order.status` directly with no transition check, allowing silent status regression on stale/duplicate webhooks                                                                                                                         | `payment.factory.ts:1158-1165,704-728,989-993`                                |
| F7  | MEDIUM       | CONFIRMED                               | Append-only `OrderEvent` audit trail is missing rows for every webhook/gateway-driven status transition — only the admin `updateStatus` path writes one                                                                                                                                                                                           | `order.service.ts:960-969` vs. `payment.factory.ts:1158-1165,704-728,989-993` |
| F8  | LOW–MED      | PLAUSIBLE                               | `refresh-refund-status` recovery endpoint's trigger condition (`payment.status==='completed'`) is unreachable for the refund-via-provider and out-of-band-webhook entry points, since both already flip `Payment.status` before the reversal could fail                                                                                           | `order.routes.ts:1099-1100`                                                   |

**Tally:** Critical 3 · High 2 · Medium 2 · Low-Medium 1 — **8 findings (7 CONFIRMED, 1 PLAUSIBLE)**.

**Common root theme:** the codebase already learned the right lesson once — `applyRefundEffects`'s own two markers (inventory restore + effects-applied) are correctly co-located in one transaction, and the affiliate/loyalty reversal functions independently do the same. But the _outer_ composition repeats the mistake the inner fix solved: the terminal status (`Order.status`/`Payment.status` = `refunded`) is written **before or separately from** the reversal effects it's supposed to represent, at three different call sites, none of which are transactionally linked to `applyRefundEffects` succeeding. Every retry/recovery surface in the system (`validTransitions`, `wasAlreadyHandled`, `refresh-refund-status`, and the refund-webhook branch's own idempotency check) was built to key off that terminal status — so the one scenario the whole system fails to handle is exactly the one the user flagged: a timeout that fires _after_ the status commits but _before_ the reversals do.

---

_Audit-only. No source modified._
