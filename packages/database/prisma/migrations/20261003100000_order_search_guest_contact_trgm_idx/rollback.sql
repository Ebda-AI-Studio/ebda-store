-- Rollback for 20261003100000_order_search_guest_contact_trgm_idx.
-- Run on the non-pooled DIRECT_URL in psql autocommit (no BEGIN): CONCURRENTLY
-- cannot run inside a transaction. Dropping an index loses no data. Roll the
-- code back first (or together): with the indexes gone the guest arm of the
-- order search is a sequential scan of the store's guest orders, not an error.
-- pg_trgm is shared with other indexes and is never dropped here.
DROP INDEX CONCURRENTLY IF EXISTS "orders_guest_first_name_trgm_idx";
DROP INDEX CONCURRENTLY IF EXISTS "orders_guest_last_name_trgm_idx";
DROP INDEX CONCURRENTLY IF EXISTS "orders_guest_email_trgm_idx";
DROP INDEX CONCURRENTLY IF EXISTS "orders_guest_phone_trgm_idx";

-- After running this, delete the migration's row too, or a later `prisma migrate deploy` treats it
-- as applied and never recreates what was rolled back:
--   DELETE FROM _prisma_migrations WHERE migration_name = '20261003100000_order_search_guest_contact_trgm_idx';
