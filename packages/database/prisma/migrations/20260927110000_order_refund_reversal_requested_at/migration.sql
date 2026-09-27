-- Migration: order_refund_reversal_requested_at
--
-- refund-reversal-stuck-sweep recovered an `order/refunded` fanout that was
-- enqueued but never ran by selecting cancelled/refunded orders with
-- refund_reversed_at IS NULL whose updated_at fell in the staleness window.
-- Two blind spots (#839, #855):
--   * a stock-restoring refund that does NOT change the order's status (a
--     manual-method full return leaves the order `delivered`) was never
--     selected, so a dropped event lost the stock restore silently;
--   * updated_at is bumped by ANY later write (tracking edit, late webhook),
--     which pushed a genuinely stuck order out of the window.
-- And a whole-order event for a still-live order (backorder-line cancel)
-- stamped refund_reversed_at, pre-claiming the order so a later genuine cancel
-- whose fanout was dropped stayed invisible (#858).
--
-- This column is stamped — and refund_reversed_at re-nulled — at every
-- whole-order stock-restoring enqueue, so the sweep keys on "a reversal was
-- requested at T and has not completed since", independent of status and of
-- unrelated writes.
--
-- Additive and nullable, no default, no backfill: every existing row stays NULL
-- and is handled exactly as before by the sweep's legacy branch (status +
-- updated_at, which the 20260720000000 backfill already made safe). Old code
-- running against the new schema simply never writes it.
ALTER TABLE "orders" ADD COLUMN "refund_reversal_requested_at" TIMESTAMP(3);

-- Partial index covering exactly the new sweep branch. Tiny at creation (every
-- row is NULL, so nothing qualifies) — the non-CONCURRENTLY build takes its
-- SHARE lock for a heap scan only; see the lock note in
-- 20260720000000_order_refund_reversed_at if that ever measurably delays boot.
CREATE INDEX IF NOT EXISTS "orders_refund_reversal_requested_idx"
  ON "orders" ("refund_reversal_requested_at")
  WHERE "refund_reversed_at" IS NULL AND "refund_reversal_requested_at" IS NOT NULL;
