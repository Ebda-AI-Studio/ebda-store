-- Rollback for 20261002090000_order_search_trgm_and_fk_indexes.
--
-- Run against the non-pooled DIRECT_URL endpoint in psql autocommit (no BEGIN):
-- DROP INDEX CONCURRENTLY cannot run inside a transaction. Dropping these only
-- returns the affected reads to sequential scans; no data is lost. Roll the
-- code back first — the order search is fast only with BOTH the rewrite in
-- OrderService.orderSearchWhere and these indexes, but it is correct without
-- the indexes.
--
-- pg_trgm is NOT dropped: the products search indexes depend on it.

DROP INDEX CONCURRENTLY IF EXISTS "orders_order_number_trgm_idx";
DROP INDEX CONCURRENTLY IF EXISTS "users_first_name_trgm_idx";
DROP INDEX CONCURRENTLY IF EXISTS "users_last_name_trgm_idx";
DROP INDEX CONCURRENTLY IF EXISTS "users_email_trgm_idx";
DROP INDEX CONCURRENTLY IF EXISTS "users_phone_trgm_idx";
DROP INDEX CONCURRENTLY IF EXISTS "ai_usage_created_at_cached_hit_idx";
DROP INDEX CONCURRENTLY IF EXISTS "cart_bundles_bundle_id_idx";

-- After running this, delete the migration's row too, or a later `prisma migrate deploy` treats it
-- as applied and never recreates what was rolled back:
--   DELETE FROM _prisma_migrations WHERE migration_name = '20261002090000_order_search_trgm_and_fk_indexes';
