-- rollback.sql for 20261123000100_search_fold_hamza (additive: drops only what it created; the original fold B objects stay).
-- Run on DIRECT_URL in psql autocommit (no BEGIN), AFTER rolling the code back (it is what calls these functions), then:
--   DELETE FROM _prisma_migrations WHERE migration_name = '20261123000100_search_fold_hamza';
DROP FUNCTION IF EXISTS public.ebda_product_search_ids_h(text, text, boolean, boolean, boolean, boolean, text[]);
DROP INDEX CONCURRENTLY IF EXISTS public.products_search_doc_h_trgm_idx;
DROP INDEX CONCURRENTLY IF EXISTS public.products_name_doc_h_trgm_idx;
DROP FUNCTION IF EXISTS public.ebda_product_search_doc_h(text, text, text, text, text);
DROP FUNCTION IF EXISTS public.ebda_product_name_doc_h(text, text, text);
DROP FUNCTION IF EXISTS public.ebda_ar_norm_h(text);
