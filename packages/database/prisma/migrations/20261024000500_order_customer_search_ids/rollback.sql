-- rollback.sql for 20261024000500_order_customer_search_ids. Roll the CODE back first
-- (order.service.ts and customer-search.service.ts call it); order/customer searches then go back
-- to the inline ILIKE (slow under RLS, same rows).
DROP FUNCTION IF EXISTS public.ebda_order_search_ids(text, text, text, integer);

-- Delete the migration's row too, or a later `prisma migrate deploy` treats it as applied:
--   DELETE FROM _prisma_migrations WHERE migration_name = '20261024000500_order_customer_search_ids';
