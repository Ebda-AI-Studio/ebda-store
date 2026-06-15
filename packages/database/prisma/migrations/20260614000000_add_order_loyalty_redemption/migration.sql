-- Loyalty redemption at checkout: record points spent + the resulting
-- discount (in fils) on the order. Additive, nullable / defaulted so existing
-- rows are unaffected and no backfill is required.
--
-- RLS: `orders` is already FORCE-RLS (tenant-scoped via app.current_store_id).
-- Table-level row security covers every column, so adding columns needs no new
-- policy — the existing per-tenant SELECT/INSERT/UPDATE/DELETE policies apply.
ALTER TABLE "orders"
  ADD COLUMN "loyalty_points_redeemed" INTEGER,
  ADD COLUMN "loyalty_discount" INTEGER NOT NULL DEFAULT 0;
