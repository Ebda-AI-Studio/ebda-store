UPDATE "plans" SET "limits" = "limits" - 'catalogImportPagesPerMonth';

-- After running this, delete the migration's row too:
--   DELETE FROM _prisma_migrations WHERE migration_name = '20261108000200_catalog_import_plan_limits';
