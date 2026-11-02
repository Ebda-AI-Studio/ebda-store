-- rollback.sql for 20261107000290_ci_store_gates.
-- Roll the CODE back first (ci-hints.service and the weekly calibration read and write this table).
-- Loses only the per-store pause state; hints resume for every store until the next calibration.
DROP TABLE IF EXISTS "ci_store_gates";

-- After running this, delete the migration's row too, or a later `prisma migrate deploy` treats it
-- as applied and never recreates what was rolled back:
--   DELETE FROM _prisma_migrations WHERE migration_name = '20261107000290_ci_store_gates';
