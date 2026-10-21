# Refund Money-Integrity Redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Stop refund/cancel from leaving durable money-loss state. Move the money reversals out of the 30s RLS request transaction (where they P2028 and half-apply) into the existing `order-refunded` Inngest fanout as retriable, dead-lettering, individually-idempotent steps.

**Architecture:** Today `OrderService.applyRefundEffects` runs inventory-restore + coupon + affiliate + loyalty×2 + backorder reversals **inline** inside the request's RLS transaction; on a heavy order it exceeds 30s → `P2028`, the status flip (committed separately) survives, and the reversals half-run and can never retry. Redesign: `applyRefundEffects` becomes a thin dispatcher that fires `order/refunded` with the reversal flags; every reversal moves into `order-refunded.ts` as its own `step.run` that runs in `runInTenantContext(storeId)`, is idempotent via a per-effect marker written **atomically with the effect**, and **throws on failure** so Inngest retries and dead-letters to the alert bridge. No heavy DB work stays on the request path.

**Tech Stack:** Express + Prisma (`withMoneyTx` interactive tx), Inngest (`step.run`, `runInTenantContext`), the existing `alerts-failure-watch` dead-letter.

## Global Constraints

- Worktree `~/Desktop/projects/_worktrees/ebda-store__fix-refund-money-integrity` (branch `fix/refund-money-integrity`). Never touch the root checkout.
- **Money reversals must be idempotent** — each effect guarded by a durable marker written IN THE SAME TRANSACTION as the effect (never before it). Retrying a completed step is a no-op; a partial failure re-runs only the missing effects.
- Reversal steps THROW on failure (Inngest retries → dead-letters). This is the OPPOSITE of the existing notification steps in `order-refunded.ts`, which swallow (`Promise.allSettled` + log) — do not swallow reversals.
- Every `prisma.*` in an Inngest step runs inside `runInTenantContext(storeId, …)` (no request middleware → RLS needs the GUC set explicitly). Follow the existing `order-refunded.ts` pattern exactly.
- The reversals must run for BOTH a paid refund AND an unpaid cancel (stock/coupon were reserved). Only the customer-facing "Refund issued" notification is gated on `notify` (paid + genuinely-new refund). So `order/refunded` now fires for every cancel/refund, carrying `{ restoreInventory, notify }`.
- Commit style: conventional, all-lowercase subject. One commit per task. Run `npx vitest run <touched test files>` per task; a full `npx vitest run tests/unit apps/api/src` before the final task.
- Do NOT change the `withMoneyTx` timeout (that's a symptom patch). The fix is removing work from the request tx, not enlarging it.

## Files

- Modify `apps/api/src/lib/inngest/functions/order-refunded.ts` — add the 5 reversal steps (inventory, coupon, affiliate, loyalty, backorder) before the notification steps; reversals throw-on-failure.
- Modify `apps/api/src/services/order.service.ts` — slim `applyRefundEffects` to fire the event with flags; remove the inline reversals + the premature `refund_effects_applied` marker; enforce the state machine helper on all status writers.
- Modify `apps/api/src/routes/order.routes.ts` — the admin `refund-via-provider` handler must not swallow a failed refund as HTTP 200.
- Test: `apps/api/src/services/__tests__/order-refund-*.test.ts`, `tests/unit/order-refunded-reversals.test.ts` (new), `tests/unit/order-status-machine.test.ts` (new).

---

### Task 1: `order/refunded` carries reversal flags; event fires for every cancel/refund

**Files:**

- Modify: `apps/api/src/services/order.service.ts` (`applyRefundEffects` ~1110-1292, and the `updateStatus` call ~1007)
- Test: `apps/api/src/services/__tests__/order-refund-gating.test.ts` (extend)

**Interfaces:**

- Produces: `order/refunded` event data shape `{ orderId: string, storeId: string, restoreInventory: boolean, notify: boolean }`. `notify` = the old `fireRefundNotification` (paid + genuinely-new). `restoreInventory` = the old option (default true; false for backorder-line cancels / no-tracked-inventory).

- [ ] **Step 1: Failing test** — `applyRefundEffects` fires `order/refunded` with both flags, for an UNPAID cancel too (notify=false, restoreInventory=true). Mock `inngest.send`; assert it's called once with `{orderId, storeId, restoreInventory:true, notify:false}`, and assert NO inline `prisma.coupon.updateMany`/`affiliateService.reverseCommission` is invoked from the service anymore.
- [ ] **Step 2: Run → fail** (`npx vitest run apps/api/src/services/__tests__/order-refund-gating.test.ts`).
- [ ] **Step 3: Implement** — replace the body of `applyRefundEffects` with: resolve `notify` via the existing `shouldApplyRefundEffects`/`fireRefundNotification` logic, then `await inngest.send({ name: 'order/refunded', data: { orderId, storeId, restoreInventory: options.restoreInventory ?? true, notify } })`. DELETE the inline inventory `withMoneyTx`, the coupon `updateMany`, the `affiliateService.reverseCommission`, both `LoyaltyService` calls, the `backorderLine.updateMany`, the `bustProductCaches`, AND the premature `refund_effects_applied` orderEvent marker (its guarded effects now live in idempotent steps). Keep the method signature so all 4 callers are unchanged.
- [ ] **Step 4: Run → pass.**
- [ ] **Step 5: Commit** `refactor(order): applyRefundEffects fires order/refunded with reversal flags`.

---

### Task 2: Inventory-restore step (idempotent, in the fanout)

**Files:**

- Modify: `apps/api/src/lib/inngest/functions/order-refunded.ts`
- Test: `tests/unit/order-refunded-reversals.test.ts` (new)

**Interfaces:**

- Consumes: event `{ orderId, storeId, restoreInventory, notify }` from Task 1. **Destructure all four** from `event.data` at the top of the handler (currently only `orderId, storeId` are read) — `notify` is used by Task 4, `restoreInventory` here.
- Produces: a `step.run('restore-inventory', …)` that, when `restoreInventory`, runs `runInTenantContext(storeId, () => withMoneyTx(prisma, async tx => { … }))` doing the per-item `FOR UPDATE` + increment + `inventoryHistory` create guarded by the `return_stock` marker (`type:'return_stock', reference:orderId`) — the EXACT logic currently in `applyRefundEffects`'s inner tx (move it verbatim). Idempotent: if the marker exists, skip. Throws on failure.

- [ ] **Step 1: Failing test** — fire the handler for an order with 2 tracked items; assert both product inventories incremented and 2 `inventoryHistory` `return_stock` rows created; fire AGAIN → assert NO double-increment (marker skip). Use the existing Inngest test harness (grep `order-created.test.ts` / `order-status-changed.test.ts` for the `step` mock pattern).
- [ ] **Step 2: Run → fail.**
- [ ] **Step 3: Implement** — add the `restore-inventory` step near the top of the handler (after `load-order`, before notifications), moving the inner-tx logic verbatim from the old `applyRefundEffects`. Guard on `if (!restoreInventory) return { skipped: true }`.
- [ ] **Step 4: Run → pass.**
- [ ] **Step 5: Commit** `feat(order): move inventory-restore into order-refunded fanout as idempotent step`.

---

### Task 3: Coupon + affiliate + loyalty + backorder reversal steps

**Files:**

- Modify: `apps/api/src/lib/inngest/functions/order-refunded.ts`
- Test: `tests/unit/order-refunded-reversals.test.ts` (extend)

**Interfaces:**

- Consumes: the event + loaded order (which has `couponCode`, `customerId`).
- **ALSO fixes a Task-2 carry-forward (Important, from review):** both the `restore-inventory` step (Task 2) AND the new `reverse-coupon` step must open their `withMoneyTx` with an order-level `SELECT id FROM public.orders WHERE id = <orderId> FOR UPDATE` raw query **before** the marker check — this restores the order-level lock the pre-Task-1 code had (old `order.service.ts` ~1131) that serialized concurrent same-order refund processing. Without it, two concurrent `order/refunded` deliveries for the same order can both pass the marker check before either commits → double-apply (double stock restore / double coupon decrement). Add the lock to Task 2's inventory step here too (grep `restore-inventory` in order-refunded.ts, add the FOR UPDATE as the first statement inside its `withMoneyTx`). Add a test: two sequential fires still single-apply (existing) PLUS assert the FOR UPDATE raw query is issued before the marker read.
- Produces: 4 more `step.run` steps, each `runInTenantContext(storeId, …)`, each idempotent, each throwing on failure:
  - `reverse-coupon` — its OWN marker (orderEvent `toStatus:'coupon_reversed'` written in the SAME tx as the `coupon.updateMany` decrement). Only when `order.couponCode`.
  - `reverse-affiliate-commission` — `affiliateService.reverseCommission(storeId, orderId)` (already internally idempotent; call it in-context).
  - `reverse-loyalty` — `LoyaltyService.reverseEarnedPointsFromOrder` + `reverseRedeemedPointsFromOrder` when `order.customerId` (already idempotent via tagged rows).
  - `cancel-backorders` — `backorderLine.updateMany({ where:{ orderItem:{orderId}, fulfilledAt:null, cancelledAt:null }, data:{ cancelledAt: new Date(), cancelledReason:'Order refunded' } })` (idempotent via the null guards).

- [ ] **Step 1: Failing test** — assert: coupon usageCount decremented exactly once across two fires; a `coupon_reversed` marker exists; `reverseCommission`/loyalty/backorder each called in-context; second fire does not double-decrement the coupon.
- [ ] **Step 2: Run → fail.**
- [ ] **Step 3: Implement** the 4 steps. For `reverse-coupon`, wrap the marker-check + decrement + marker-write in one `withMoneyTx` so they're atomic (marker written WITH the effect — this is the premature-marker fix).
- [ ] **Step 4: Run → pass.**
- [ ] **Step 5: Commit** `feat(order): move coupon/affiliate/loyalty/backorder reversals into fanout steps`.

---

### Task 4: Reversal steps dead-letter on terminal failure (not swallow)

**Files:**

- Modify: `apps/api/src/lib/inngest/functions/order-refunded.ts`
- Test: `tests/unit/order-refunded-reversals.test.ts` (extend)

**Interfaces:**

- Consumes: the reversal steps from Tasks 2-3; `notify` from Task 2's destructure.
- Produces: (a) reversal steps run SEQUENTIALLY and THROW (so Inngest's `retries:3` re-runs and, on exhaustion, the function fails → the existing `alerts-failure-watch`/dead-letter fires); (b) the NOTIFICATION block (email/dispatcher/push) is **gated on `notify`** and stays in the swallowing `Promise.allSettled`. Two-tier: reversals (always run, throw) THEN notifications (only when `notify`, swallow).

  **WHY the notify gate is mandatory (plan gap caught in Task 1 review):** pre-redesign, `order/refunded` was only _sent_ when `fireRefundNotification` was true, so this consumer never needed a gate. Now the event fires for EVERY cancel/refund (unpaid cancels too). Without `if (!notify)` around the notifications, every unpaid cancel would email the customer "Refund issued" + WhatsApp/SMS + push the merchant — re-introducing the exact spurious-notification bug `order.service.ts` comments say was previously fixed. The reversals must still run on an unpaid cancel (stock/coupon were reserved); only the notifications are gated.

- [ ] **Step 1: Failing tests** — (a) make `reverse-coupon`'s tx throw; assert the handler REJECTS (Inngest retries) and the notification steps did NOT run (reversals gate notifications); (b) a notification throws → handler RESOLVES (swallowed); (c) **`notify:false` (unpaid cancel) → reversals RAN but NONE of the 3 notification steps ran** (email/dispatcher/push not called); (d) `notify:true` → notifications ran.
- [ ] **Step 2: Run → fail.**
- [ ] **Step 3: Implement** — reversal steps sequential + uncaught (throw propagates); wrap the notification `Promise.allSettled` block in `if (notify) { … }`; comment the two-tier policy.
- [ ] **Step 4: Run → pass.**
- [ ] **Step 5: Commit** `feat(order): reversals dead-letter; notifications gated on notify + best-effort`.

---

### Task 5: Admin `refund-via-provider` stops swallowing failures

**Files:**

- Modify: `apps/api/src/routes/order.routes.ts` (the `refund-via-provider` handler ~1178)
- Test: `tests/unit/order-refund-permission.test.ts` (extend) or a new `order-refund-route.test.ts`

**Interfaces:**

- Consumes: nothing new.
- Produces: the handler returns a 5xx (via `next(err)`) when the provider refund call or the status update fails, instead of a silent 200. (The reversals are now reliable via the queue, so the route's job is just: call provider refund + flip status + fire event; any failure there must surface.)

- [ ] **Step 1: Failing test** — mock the provider refund to throw; assert the route responds non-2xx (not 200) and the error reaches the error handler.
- [ ] **Step 2: Run → fail** (route currently 200s).
- [ ] **Step 3: Implement** — remove the swallowing `.catch(() => …)` / try-that-returns-200 around the provider refund; let errors flow to `next(err)`. Keep the audit log.
- [ ] **Step 4: Run → pass.**
- [ ] **Step 5: Commit** `fix(order): surface provider-refund failures instead of returning 200`.

---

### Task 6: Enforce the status state machine on ALL writers

**Files:**

- Modify: `apps/api/src/services/order.service.ts` (extract the `validTransitions` check from `updateStatus` into a reusable `assertValidTransition(from, to)` helper)
- Modify: the 3 webhook/gateway sites that write `Order.status` directly (grep `order.update` with a `status:` in payment/webhook services — the money-integrity audit named 3)
- **ALSO (fix-the-class carry-forward from Task 5 review):** `apps/api/src/routes/order.routes.ts` `/refresh-refund-status` route (~line 1102) has the IDENTICAL swallow-around-`applyRefundEffects` pattern Task 5 fixed on `refund-via-provider` — it logs-and-returns-200 on failure, so a failed reversal-event dispatch is silent. Remove that swallow too (let it reach `next(err)`), same as Task 5. Add a test that a throwing `applyRefundEffects`/refund on this route surfaces non-2xx.
- Test: `tests/unit/order-status-machine.test.ts` (new)

**Interfaces:**

- Consumes: nothing.
- Produces: `assertValidTransition(from: OrderStatus, to: OrderStatus): void` (throws `AppError(400,'INVALID_STATUS_TRANSITION')`) exported from order.service; every direct `order.update({status})` call site calls it first with the loaded prior status.

- [ ] **Step 1: Failing test** — a stale webhook trying `refunded → processing` (backwards) is rejected by `assertValidTransition`; a valid forward transition passes.
- [ ] **Step 2: Run → fail.**
- [ ] **Step 3: Implement** — extract the helper; wire it into `updateStatus` (replacing the inline check) and the 3 direct writers (grep them: read the loaded order's prior status, call the helper before `order.update`).
- [ ] **Step 4: Run → pass; then full suite** `npx vitest run tests/unit apps/api/src`.
- [ ] **Step 5: Commit** `fix(order): enforce status state machine on all writers`.

---

## Self-Review

- **Spec coverage:** move reversals off request tx (T1-3), idempotent-with-marker (T2-3, coupon marker atomic in T3), dead-letter not swallow (T4), stop swallowing admin 200 (T5), state machine on all writers (T6). All covered.
- **Placeholder scan:** the 3 direct status-writer sites in T6 are "grep them" — the implementer must locate the exact 3 from the money-integrity audit (`docs/audits/2026-07-15-money-integrity-audit.md` F6); acceptable (audit names them). No other placeholders.
- **Type consistency:** event shape `{orderId,storeId,restoreInventory,notify}` consistent T1→T2→T3; `assertValidTransition(from,to)` consistent in T6.
