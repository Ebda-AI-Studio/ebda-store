-- rollback.sql for 20261022000100_product_embeddings.
-- Roll the CODE back first (the indexer and the hybrid search read/write this table).
-- Loses only the vectors (re-derivable: the indexer re-embeds every product). The `vector`
-- extension is left installed on purpose (harmless, and other objects may use it later).
DROP TABLE IF EXISTS "product_embeddings";
DROP FUNCTION IF EXISTS public.ebda_product_embed_doc(text, text, text, text, text);

-- After running this, delete the migration's row too, or a later `prisma migrate deploy` treats it
-- as applied and never recreates what was rolled back:
--   DELETE FROM _prisma_migrations WHERE migration_name = '20261022000100_product_embeddings';
