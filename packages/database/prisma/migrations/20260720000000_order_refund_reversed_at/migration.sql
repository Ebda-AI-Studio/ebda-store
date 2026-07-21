-- Migration: order_refund_reversed_at
--
-- Adds a completion claim for the order/refunded reversal fanout.
--
-- applyRefundEffects only ENQUEUES `order/refunded`; the reversals (inventory,
-- coupon, affiliate, loyalty, backorders) run in the Inngest fanout. A FAILED
-- enqueue propagates and every call site handles it, but a SUCCESSFUL enqueue
-- whose event is never consumed (Inngest outage, bad signing key, worker down,
-- event dropped mid-deploy) is completely silent: the order reads `cancelled`,
-- the customer is refunded, and the stock is never returned.
--
-- `order/created` already has this safety net via order_created_notified_at +
-- order-created-stuck-sweep. This column is the refund-path equivalent, read by
-- refund-reversal-stuck-sweep.
--
-- It is NOT derivable from the existing `return_stock` InventoryHistory marker:
-- that marker is legitimately absent for restoreInventory:false calls (backorder
-- line cancels, where stock was never reserved) and for orders whose products
-- all have track_inventory=false. Sweeping on marker-absence would re-fire those
-- forever and, in the backorder case, invent stock that never existed.
--
-- Additive, nullable, no backfill, no default — safe to apply while the old
-- code is still running (it simply never writes the column). Existing rows stay
-- NULL, which is why the sweep MUST carry a recency floor: without one its first
-- tick would re-fire reversals for every cancelled/refunded order in history.
ALTER TABLE "orders" ADD COLUMN "refund_reversed_at" TIMESTAMP(3);

-- BACKFILL — the same mitigation order_created_notified_at documents.
--
-- Every already-cancelled/refunded order starts NULL, which to the sweep is
-- indistinguishable from "the reversal never ran". The recency floor alone
-- would keep them out of the window, but that leaves the floor as the SINGLE
-- thing standing between a deploy and re-firing five reversal steps across the
-- whole order history. Backfilling makes NULL mean "cancelled AFTER this
-- migration and genuinely unreversed", so the floor becomes a second line of
-- defence rather than the only one.
--
-- Stamped with `updated_at`, not `now()`: these reversals ran (or didn't) at
-- some point in the past, and claiming they completed at migration time would
-- be a timestamp we cannot support. This is explicitly a "considered handled as
-- of the order's last change" marker for pre-existing rows — genuinely stuck
-- historical orders are NOT recovered by this sweep and would need a one-off
-- manual reconciliation.
UPDATE "orders"
   SET "refund_reversed_at" = "updated_at"
 WHERE "status" IN ('cancelled', 'refunded')
   AND "refund_reversed_at" IS NULL;

-- Partial index covering exactly the slice the sweep scans (unclaimed
-- cancelled/refunded orders, ordered by updated_at), so the 5-minute cron never
-- seq-scans `orders`.
--
-- LOCK NOTE (same constraint documented in 20260711120000_loyalty_earn_unique):
-- this is a plain, non-CONCURRENTLY CREATE INDEX, because CONCURRENTLY cannot
-- run inside Prisma's migration transaction. It therefore takes a SHARE lock
-- that blocks writes to `orders` while the index builds — and FWB applies
-- migrations on API boot, so that also gates boot for that window.
--
-- Unlike loyalty_transactions, `orders` is NOT a small table and will only grow.
-- The index is partial but Postgres still scans the heap to build it. If this
-- measurably delays boot, build it out-of-band instead:
--
--   CREATE INDEX CONCURRENTLY "orders_refund_reversal_pending_idx"
--     ON "orders" ("updated_at")
--     WHERE "refund_reversed_at" IS NULL AND "status" IN ('cancelled','refunded');
--
-- then mark this migration applied (`prisma migrate resolve --applied`).
CREATE INDEX IF NOT EXISTS "orders_refund_reversal_pending_idx"
  ON "orders" ("updated_at")
  WHERE "refund_reversed_at" IS NULL AND "status" IN ('cancelled', 'refunded');
