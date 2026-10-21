-- B2B review M1: record WHEN the applicant accepted the data notice shown on the apply form (nullable: rows created before
-- this migration have no consent timestamp and are not backfilled).
ALTER TABLE "wholesale_applications" ADD COLUMN IF NOT EXISTS "consent_at" TIMESTAMP(3);
