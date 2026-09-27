-- Migration: order_status_fanout_claim
--
-- OrderService.updateStatus fans its post-transition side effects (payment-
-- success / shipped emails, WhatsApp/SMS/push dispatch, affiliate commission,
-- loyalty award, carrier auto-ship, admin refund email) out on the
-- `order/status-changed` Inngest event. Two gaps:
--   #558  no cross-event dedup: two events for the same order + transition
--         each ran every email and dispatch step;
--   #619  no recovery for an event that was ACCEPTED but never delivered —
--         the inline fallback only covers a rejected enqueue.
--
-- updateStatus stamps status_fanout_requested_at and re-nulls
-- status_fanout_claimed_at with every transition (same UPDATE as the status).
-- The fanout claims status_fanout_claimed_at before any side effect, only while
-- the order is still at the event's status. order-status-fanout-stuck-sweep
-- re-sends a transition requested past its window and never claimed.
--
-- Additive, nullable, no default, no backfill. Existing rows stay NULL/NULL and
-- are never swept (the sweep keys on requested_at). Old code running against
-- the new schema never writes them.
ALTER TABLE "orders" ADD COLUMN "status_fanout_requested_at" TIMESTAMP(3);
ALTER TABLE "orders" ADD COLUMN "status_fanout_claimed_at" TIMESTAMP(3);

-- Partial index over exactly what the sweep scans; empty at creation.
CREATE INDEX IF NOT EXISTS "orders_status_fanout_pending_idx"
  ON "orders" ("status_fanout_requested_at")
  WHERE "status_fanout_claimed_at" IS NULL AND "status_fanout_requested_at" IS NOT NULL;
