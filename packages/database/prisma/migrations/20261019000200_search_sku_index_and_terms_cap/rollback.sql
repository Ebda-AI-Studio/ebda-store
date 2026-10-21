-- rollback.sql for 20261019000200_search_sku_index_and_terms_cap.
-- Run on DIRECT_URL in psql autocommit (no BEGIN). Roll the CODE back first. Dropping the index
-- loses no data (the admin SKU arm goes back to a sequential scan); dropping the CHECK loses none.
DROP INDEX CONCURRENTLY IF EXISTS "products_sku_norm_trgm_idx";
ALTER TABLE "products" DROP CONSTRAINT IF EXISTS "products_search_terms_len_chk";

-- After running this, delete the migration's row too, or a later `prisma migrate deploy` treats it
-- as applied and never recreates what was rolled back:
--   DELETE FROM _prisma_migrations WHERE migration_name = '20261019000200_search_sku_index_and_terms_cap';
