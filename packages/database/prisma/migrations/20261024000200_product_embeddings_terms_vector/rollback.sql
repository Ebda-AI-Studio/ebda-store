-- rollback.sql for 20261024000200_product_embeddings_terms_vector.
-- Roll the CODE back first (the indexer writes and the vector leg reads these columns). Loses only
-- the words vectors (re-derivable: the indexer re-embeds them once the code is back).
ALTER TABLE "product_embeddings" DROP CONSTRAINT IF EXISTS "product_embeddings_terms_pair_chk";
ALTER TABLE "product_embeddings" DROP COLUMN IF EXISTS "terms_hash";
ALTER TABLE "product_embeddings" DROP COLUMN IF EXISTS "terms_embedding";

-- After running this, delete the migration's row too, or a later `prisma migrate deploy` treats it
-- as applied and never recreates what was rolled back:
--   DELETE FROM _prisma_migrations WHERE migration_name = '20261024000200_product_embeddings_terms_vector';
