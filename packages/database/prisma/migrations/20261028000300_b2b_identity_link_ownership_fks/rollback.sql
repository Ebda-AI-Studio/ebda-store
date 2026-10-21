-- rollback.sql for 20261028000300_b2b_identity_link_ownership_fks.
-- Roll the CODE back first (the PriceResolver binds the buyer through customers.user_id).
-- Loses the customers.user_id links: after this, NO shopper resolves to a group price until the links are recreated by
-- re-approving applications (Task 5) or re-selecting the group on each registered shopper's profile.
ALTER TABLE "customers" DROP CONSTRAINT IF EXISTS "customers_store_group_fkey";
ALTER TABLE "wholesale_applications" DROP CONSTRAINT IF EXISTS "wholesale_applications_store_group_fkey";
ALTER TABLE "wholesale_applications" DROP CONSTRAINT IF EXISTS "wholesale_applications_store_user_fkey";
ALTER TABLE "product_price_tiers" DROP CONSTRAINT IF EXISTS "product_price_tiers_store_group_fkey";
ALTER TABLE "product_price_tiers" DROP CONSTRAINT IF EXISTS "product_price_tiers_product_variant_fkey";
ALTER TABLE "product_price_tiers" DROP CONSTRAINT IF EXISTS "product_price_tiers_store_product_fkey";
ALTER TABLE "customers" DROP CONSTRAINT IF EXISTS "customers_store_id_user_id_fkey";
DROP INDEX IF EXISTS "customers_store_id_user_id_key";
ALTER TABLE "customers" DROP COLUMN IF EXISTS "user_id";
DROP INDEX IF EXISTS "users_store_id_id_key";
DROP INDEX IF EXISTS "customer_groups_store_id_id_key";
DROP INDEX IF EXISTS "product_variants_product_id_id_key";
DROP INDEX IF EXISTS "products_store_id_id_key";

-- After running this, delete the migration's row too:
--   DELETE FROM _prisma_migrations WHERE migration_name = '20261028000300_b2b_identity_link_ownership_fks';
