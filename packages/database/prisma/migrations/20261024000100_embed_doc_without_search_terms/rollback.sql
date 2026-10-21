-- rollback.sql for 20261024000100_embed_doc_without_search_terms.
-- Roll the CODE back first: the indexer (product-index.service.ts DOC) calls the 4-argument
-- function this drops. The 5-argument doc (WITH the AI search words) was KEPT by this migration
-- (expand-then-contract, SEARCH-T13-8), so the previous code works as soon as it is back; every
-- product with search words then reads stale to it and is re-embedded (nothing is lost).

DROP FUNCTION IF EXISTS public.ebda_product_embed_doc(text, text, text, text);

-- After running this, delete the migration's row too, or a later `prisma migrate deploy` treats it
-- as applied and never recreates what was rolled back:
--   DELETE FROM _prisma_migrations WHERE migration_name = '20261024000100_embed_doc_without_search_terms';
