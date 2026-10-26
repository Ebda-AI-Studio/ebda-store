DROP INDEX IF EXISTS "instapay_receipts_retention_idx";
ALTER TABLE "instapay_receipts" DROP COLUMN IF EXISTS "personal_scrubbed_at";
ALTER TABLE "instapay_receipts" DROP COLUMN IF EXISTS "image_deleted_at";
