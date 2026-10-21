-- rollback.sql for 20261027000100_admin_search_norm. Roll the CODE back first (the definer of
-- 20261027000200 and the services use these expressions). Run each statement on its own, autocommit.
DROP INDEX CONCURRENTLY IF EXISTS "users_phone_digits_trgm_idx";
DROP INDEX CONCURRENTLY IF EXISTS "users_name_norm_trgm_idx";
DROP INDEX CONCURRENTLY IF EXISTS "orders_guest_phone_digits_trgm_idx";
DROP INDEX CONCURRENTLY IF EXISTS "orders_guest_name_norm_trgm_idx";
-- keep public.ebda_digits (harmless); drop it only if 20261027000200 is also rolled back:
-- DROP FUNCTION IF EXISTS public.ebda_digits(text);
-- DELETE FROM _prisma_migrations WHERE migration_name = '20261027000100_admin_search_norm';
