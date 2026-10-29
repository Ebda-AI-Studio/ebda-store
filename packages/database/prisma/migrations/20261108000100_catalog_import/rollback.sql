-- rollback.sql for 20261108000100_catalog_import. Roll the CODE back first. Drops all staged review rows.
DROP TABLE IF EXISTS "catalog_import_items";
DROP TABLE IF EXISTS "catalog_import_files";
DROP TABLE IF EXISTS "catalog_import_jobs";
