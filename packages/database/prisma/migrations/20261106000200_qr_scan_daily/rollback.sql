-- rollback.sql for 20261106000200_qr_scan_daily.
-- Roll the CODE back first (the scan beacon and the admin QR page use this table).
-- Loses only the QR scan counters; no other table references it.
DROP TABLE IF EXISTS "qr_scan_daily";

-- After running this, delete the migration's row too, or a later `prisma migrate deploy` treats it
-- as applied and never recreates what was rolled back:
--   DELETE FROM _prisma_migrations WHERE migration_name = '20261106000200_qr_scan_daily';
