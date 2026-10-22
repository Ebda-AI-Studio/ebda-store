-- B2B Task 8b (Ruling B2B-10 / B2B-13): tier-aware partial return refunds.
-- order_items.tier_ladder: the price breaks the buyer could reach, snapshotted at sale time so a later partial return reprices
-- the kept units from what was on offer then (never from a live table). NULL on orders placed before this column = no adjustment.
-- return_items.*: what the refund was reduced by (signed piastres), whether the merchant overrode it, and who/why. Snapshots,
-- so history is never re-derived.
ALTER TABLE "order_items" ADD COLUMN IF NOT EXISTS "tier_ladder" JSONB;
ALTER TABLE "return_items"
  ADD COLUMN IF NOT EXISTS "tier_adjustment" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "adjustment_overridden" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "adjustment_override_reason" TEXT,
  ADD COLUMN IF NOT EXISTS "adjustment_override_by" TEXT;
