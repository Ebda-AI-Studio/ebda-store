-- rollback.sql for 20261028000200_b2b_product_columns_order_snapshots.
-- Roll the CODE back first (the resolver, checkout and invoice read these columns).
-- Loses: group pricing config, product MOQ/audience (wholesale-only products become PUBLIC again
-- the moment audience is dropped - set them to draft first if that matters) and every order line's
-- price provenance snapshot. Prices actually charged (order_items.price/total) are untouched.
UPDATE "plans" SET "limits" = "limits" - 'wholesalePricing';
ALTER TABLE "orders" DROP COLUMN IF EXISTS "price_group_name";
ALTER TABLE "order_items"
  DROP CONSTRAINT IF EXISTS "order_items_price_source_chk",
  DROP COLUMN IF EXISTS "price_tier_min_qty",
  DROP COLUMN IF EXISTS "price_source",
  DROP COLUMN IF EXISTS "list_price";
ALTER TABLE "products"
  DROP CONSTRAINT IF EXISTS "products_audience_chk",
  DROP CONSTRAINT IF EXISTS "products_moq_chk",
  DROP COLUMN IF EXISTS "audience",
  DROP COLUMN IF EXISTS "moq";
ALTER TABLE "customer_groups"
  DROP CONSTRAINT IF EXISTS "customer_groups_discount_bps_chk",
  DROP CONSTRAINT IF EXISTS "customer_groups_pricing_mode_chk",
  DROP COLUMN IF EXISTS "is_wholesale",
  DROP COLUMN IF EXISTS "requires_approval",
  DROP COLUMN IF EXISTS "discount_bps",
  DROP COLUMN IF EXISTS "pricing_mode";

-- After running this, delete the migration's row too:
--   DELETE FROM _prisma_migrations WHERE migration_name = '20261028000200_b2b_product_columns_order_snapshots';
