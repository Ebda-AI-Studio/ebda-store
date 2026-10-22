-- rollback.sql for 20261028000600_b2b_order_item_group_applied.
-- Roll the CODE back first (order-pricing.ts, analytics.service.ts and the invoice / fiscal renderers read this column).
-- Loses only the label distinction: lines fall back to price_source.
ALTER TABLE "order_items" DROP COLUMN IF EXISTS "price_group_applied";

-- After running this, delete the migration's row too:
--   DELETE FROM _prisma_migrations WHERE migration_name = '20261028000600_b2b_order_item_group_applied';
