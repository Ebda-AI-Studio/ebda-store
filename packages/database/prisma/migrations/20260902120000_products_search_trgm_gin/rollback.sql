-- Rollback for 20260902120000_products_search_trgm_gin.
--
-- Run against the non-pooled DIRECT_URL endpoint (CONCURRENTLY cannot run
-- inside a transaction — psql autocommit, no BEGIN). Dropping the indexes
-- only degrades search back to sequential scans; it loses no data.
--
-- The pg_trgm EXTENSION is deliberately NOT dropped: other objects may
-- depend on it and CREATE EXTENSION IF NOT EXISTS makes re-application
-- idempotent either way.

DROP INDEX CONCURRENTLY IF EXISTS "products_name_trgm_idx";
DROP INDEX CONCURRENTLY IF EXISTS "products_name_ar_trgm_idx";
DROP INDEX CONCURRENTLY IF EXISTS "products_description_trgm_idx";
DROP INDEX CONCURRENTLY IF EXISTS "products_description_ar_trgm_idx";

-- After running this, delete the migration's row too, or a later `prisma migrate deploy` treats it
-- as applied and never recreates what was rolled back:
--   DELETE FROM _prisma_migrations WHERE migration_name = '20260902120000_products_search_trgm_gin';
