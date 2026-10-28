DROP INDEX IF EXISTS "instapay_receipts_retention_idx";
ALTER TABLE "instapay_receipts" DROP COLUMN IF EXISTS "personal_scrubbed_at";
ALTER TABLE "instapay_receipts" DROP COLUMN IF EXISTS "image_deleted_at";

-- After running this, delete the migration's row too, or a later `prisma migrate deploy` treats it
-- as applied and never recreates what was rolled back:
--   DELETE FROM _prisma_migrations WHERE migration_name = '20261106000250_instapay_receipt_retention';
