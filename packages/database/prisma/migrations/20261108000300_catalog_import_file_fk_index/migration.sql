-- The file_id foreign key (ON DELETE CASCADE) had no leading index: deleting a catalog_import_files row scanned catalog_import_items.
CREATE INDEX IF NOT EXISTS "catalog_import_items_file_id_idx" ON "catalog_import_items"("file_id");
