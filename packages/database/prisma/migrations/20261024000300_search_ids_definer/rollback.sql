-- rollback.sql for 20261024000300_search_ids_definer. Roll the CODE back first (product-search
-- .service.ts calls this function); searches then go back to the (slow under RLS) inline LIKE.
DROP FUNCTION IF EXISTS public.ebda_product_search_ids(text, text, boolean, boolean, boolean, text[]);

-- Delete the migration's row too, or a later `prisma migrate deploy` treats it as applied:
--   DELETE FROM _prisma_migrations WHERE migration_name = '20261024000300_search_ids_definer';
