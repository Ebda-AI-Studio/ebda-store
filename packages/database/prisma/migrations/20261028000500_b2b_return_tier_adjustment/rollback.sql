-- rollback.sql for 20261028000500_b2b_return_tier_adjustment.
-- Roll the CODE back first (ReturnService reads these columns). Loses the ladder snapshots and the per-return adjustments:
-- completed returns keep their refunded amounts (those live on returns.refund_amount), only the explanation is dropped.
ALTER TABLE "return_items"
  DROP COLUMN IF EXISTS "adjustment_override_by",
  DROP COLUMN IF EXISTS "adjustment_override_reason",
  DROP COLUMN IF EXISTS "adjustment_overridden",
  DROP COLUMN IF EXISTS "tier_adjustment";
ALTER TABLE "order_items" DROP COLUMN IF EXISTS "tier_ladder";

-- After running this, delete the migration's row too:
--   DELETE FROM _prisma_migrations WHERE migration_name = '20261028000500_b2b_return_tier_adjustment';
