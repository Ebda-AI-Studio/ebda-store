-- Migration: return_partial_reversal_stamps
--
-- A PARTIAL return's item-level `order/refunded` event is sent only after the
-- request transaction commits (deferAfterTenantCommit, Ruling AP-2). If that
-- post-commit enqueue fails, the Return is `completed`, the customer has been
-- refunded, and the returned lines are never restocked and the pro-rata GL
-- adjustment never posts. Whole-order reversals already recover from this via
-- orders.refund_reversal_requested_at + refund-reversal-stuck-sweep; partial
-- ones had no stamp and no sweep (issues 2246 / 2267).
--
-- reversal_requested_at is stamped in the SAME transaction that completes the
-- return (so a rolled-back request leaves nothing to recover), and
-- reversal_applied_at by the fanout's partial arm once the event has run. The
-- sweep re-sends the item-level event for a return requested but not applied.
--
-- Additive and nullable, no default, no backfill: existing returns stay NULL
-- and the sweep never selects them. Old code running against the new schema
-- simply never writes either column.
ALTER TABLE "returns" ADD COLUMN "reversal_requested_at" TIMESTAMP(3);
ALTER TABLE "returns" ADD COLUMN "reversal_applied_at" TIMESTAMP(3);

-- Partial index covering exactly the sweep's predicate; empty at creation.
CREATE INDEX IF NOT EXISTS "returns_reversal_pending_idx"
  ON "returns" ("reversal_requested_at")
  WHERE "reversal_applied_at" IS NULL AND "reversal_requested_at" IS NOT NULL;
