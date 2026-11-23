# Refund-reversal stuck sweep — closing the silent stock-loss path

_2026-07-20. Money-critical. Read the "Two ways to make this worse" section before writing code._

## The bug

`OrderService.applyRefundEffects` enqueues `order/refunded` and returns. The actual
reversals — inventory restore, coupon usage, affiliate commission, loyalty points,
backorder lines — run in the Inngest fanout (`lib/inngest/functions/order-refunded.ts`).

A **failed** enqueue propagates and every call site handles it. But a **successful**
enqueue whose event is never consumed — Inngest outage, misconfigured signing key, a
worker that never came up, an event dropped mid-deploy — is completely silent. The order
shows `cancelled`, the customer is refunded, and the stock is never returned. Nobody finds
out until a merchant notices phantom out-of-stock.

`order/created` already has exactly this safety net (`order-created-stuck-sweep`). The
refund path has none — verified: the four existing sweeps are order-created,
order-stuck-payment, payment-abandonment, payment-webhook-stuck.

## Why marker-absence alone cannot detect it

The obvious query — "cancelled/refunded orders with no `return_stock` InventoryHistory
marker" — is **wrong and dangerous**, because two legitimate paths also write no marker:

1. **`restoreInventory: false`** — `accounting/backorder.service.ts:104` cancels backorder
   lines whose stock was never reserved. Re-firing with `restoreInventory: true` would
   invent stock that never existed.
2. **`trackInventory: false` products** — the restore loop `continue`s past them, so a
   fully-untracked order legitimately produces no history row at all.

Both would be swept forever, every 5 minutes. The first would create phantom stock — a
money bug in the _opposite_ direction, worse than the one we are fixing.

So we need a claim that records **"the fanout ran to completion"**, independent of whether
any stock actually moved. That is precisely what `Order.orderCreatedNotifiedAt` does for
the created path, so we mirror it.

## Design

**Schema:** one nullable column, additive, no backfill.

```prisma
/// Stamped by the order/refunded fanout once ALL reversal steps complete —
/// regardless of whether any stock actually moved (restoreInventory:false and
/// untracked-inventory orders legitimately move none). NULL past the staleness
/// window means the fanout never ran, which is what refund-reversal-stuck-sweep
/// recovers. Do NOT reuse the return_stock InventoryHistory marker for this:
/// that marker is absent in several legitimate cases.
refundReversedAt DateTime? @map("refund_reversed_at")
```

**Fanout:** a final `step.run('claim-reversed')` after every reversal step, stamping
`refundReversedAt`. It must be LAST — stamping earlier would mark an order done while a
later step is still failing, permanently hiding it from the sweep.

**Sweep:** `refund-reversal-stuck-sweep`, cron `*/5 * * * *`, mirroring
`order-created-stuck-sweep` structure exactly (extracted `handleRefundReversalStuckSweep(step)`
for testability, `withRlsBypass` cross-tenant read, `SWEEP_TAKE = 200`, P1 alert on very-stale).

Query: `status IN ('cancelled','refunded') AND refundReversedAt IS NULL AND updatedAt < cutoff AND updatedAt > floor`.

## Two ways to make this worse — both must be handled

### 1. The back-catalog stampede (this already happened once)

`order-created-stuck-sweep` carries a P0 comment dated 2026-07-09: the first version had no
lower bound, so its first run swept **every** paid order whose claim was NULL — the entire
historical order book — and re-fired the fanout for all of them.

Our exposure is worse, because `refundReversedAt` is NULL for **every cancelled or refunded
order that has ever existed**. Without a floor, the first tick after deploy re-fires
reversals across the whole history.

Mitigation, both required:

- `REFUND_REVERSAL_MAX_AGE_MINUTES` recency floor (default 720 = 12h), same shape as the
  created sweep.
- The floor is load-bearing, not an optimization. It gets its own test.

### 2. Re-firing is only safe if every step is idempotent

The sweep re-sends the whole event, and a fresh event re-executes every `step.run` from
scratch (Inngest memoizes within a run, not across events). Current state:

- `restore-inventory` — idempotent via the `return_stock` InventoryHistory marker + an
  order-level `FOR UPDATE` lock. Covered by `tests/unit/order-refunded-reversals.test.ts`
  ("is idempotent — firing again with the return_stock marker present does NOT double-increment").
- `reverse-coupon` — idempotent via a `coupon_reversed` OrderEvent marker. Covered.
- `reverse-affiliate-commission`, `reverse-loyalty`, `cancel-backorders` — idempotency lives
  in the service methods and is NOT asserted by a re-fire test.

**Task 3 must verify those three before the sweep ships.** If any is not idempotent, a
re-fire double-reverses loyalty points or commission — real money. If one cannot be made
idempotent cheaply, the sweep must skip that step on a recovery re-fire rather than ship a
double-apply.

## Tasks

### Task 1 — schema + claim stamp

- Add the column to `packages/database/prisma/schema.prisma`, generate the migration
  (additive nullable, no backfill, zero-downtime).
- Add the final `claim-reversed` step to `order-refunded.ts`.
- Test: the fanout stamps `refundReversedAt` even when `restoreInventory: false`, and even
  when every product is untracked. This is the case marker-absence gets wrong, so it is the
  case that must be pinned.
- Test: stamping is last — a throwing reversal step leaves the claim NULL.

### Task 2 — the sweep

- `apps/api/src/lib/inngest/functions/refund-reversal-stuck-sweep.ts`, mirroring
  `order-created-stuck-sweep.ts`.
- Register in `lib/inngest/client.ts`.
- Tests (mirror `tests/unit/order-created-stuck-sweep.test.ts`): re-sends for a stale
  unclaimed order; does NOT re-send inside the grace window; **does NOT re-send an order
  older than the recency floor**; does not re-send a claimed order; P1 alert fires past 3×
  the window.

### Task 3 — idempotency verification for the remaining three steps

- Read `affiliateService.reverseCommission`, the two loyalty reversal methods, and the
  backorder cancel. Determine whether a second call is a no-op.
- Add re-fire tests to `tests/unit/order-refunded-reversals.test.ts` asserting each is
  idempotent, or fix them.
- If any cannot be made idempotent, stop and report rather than shipping the sweep.

### Task 4 — docs + env

- `docs/ENVIRONMENT.md`: `REFUND_REVERSAL_STUCK_MINUTES`, `REFUND_REVERSAL_MAX_AGE_MINUTES`.
- Blast-radius sweep over `refundReversedAt`, `refund_reversed_at`, `order/refunded`,
  the new function id, and the two env names.

## Out of scope

Making `applyRefundEffects` restore inventory synchronously. #758 deliberately moved
reversals off the request transaction for money integrity; reverting that is not a fix.
