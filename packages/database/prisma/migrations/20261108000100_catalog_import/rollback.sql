-- rollback.sql for 20261108000100_catalog_import. Roll the CODE back first. Drops all staged review rows.
DROP TABLE IF EXISTS "catalog_import_items";
DROP TABLE IF EXISTS "catalog_import_files";
DROP TABLE IF EXISTS "catalog_import_jobs";

-- After running this, delete the migration's row too:
--   DELETE FROM _prisma_migrations WHERE migration_name = '20261108000100_catalog_import';
