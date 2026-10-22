-- rollback.sql for 20261027000200_customer_search_ids. Roll the CODE back first
-- (admin-search.service.ts calls it).
DROP FUNCTION IF EXISTS public.ebda_customer_search_ids(text, text[], text, text, integer, integer);
-- DELETE FROM _prisma_migrations WHERE migration_name = '20261027000200_customer_search_ids';
