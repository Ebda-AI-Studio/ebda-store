-- rollback.sql for 20261024000400_product_embeddings_inline_vectors: back to the default TOAST
-- threshold. Existing rows keep their inline vectors; only new rows are TOASTed again.
ALTER TABLE "product_embeddings" RESET (toast_tuple_target);

-- Delete the migration's row too, or a later `prisma migrate deploy` treats it as applied:
--   DELETE FROM _prisma_migrations WHERE migration_name = '20261024000400_product_embeddings_inline_vectors';
