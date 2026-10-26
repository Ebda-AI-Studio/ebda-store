-- rollback.sql for 20261104000600_barcode_unique.
-- Roll the CODE back first (the allocator and the write-path validator rely on these indexes).
-- Barcodes the migration cleared on duplicate rows are NOT restored.
DROP INDEX IF EXISTS "products_store_id_barcode_uniq";
DROP INDEX IF EXISTS "product_variants_product_id_barcode_uniq";

-- After running this, delete the migration's row too:
--   DELETE FROM _prisma_migrations WHERE migration_name = '20261104000600_barcode_unique';
