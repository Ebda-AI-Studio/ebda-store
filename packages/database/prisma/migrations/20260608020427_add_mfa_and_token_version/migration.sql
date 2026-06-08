-- Add MFA / 2FA columns and the session-revocation token version to `users`.
--
-- NOTE: this migration intentionally contains ONLY the MFA + token_version
-- additions. An earlier `prisma migrate dev` run captured a large pile of
-- unrelated schema drift here (dropping `users_email_key` /
-- `users_store_id_idx`, dropping the `payments.stripe_*` reference columns,
-- adding a `UNIQUE (store_id, sku)` on products, forcing `tags.store_id`
-- NOT NULL, FK drop/re-adds and index renames). None of that belongs to
-- this feature and most of it was destructive / boot-failure-prone, so it
-- was removed. If any of those schema changes are genuinely intended, they
-- must ship in their own dedicated, reviewed migration.

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "mfa_backup_codes" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "mfa_enabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "mfa_enrolled_at" TIMESTAMP(3),
ADD COLUMN     "mfa_secret" TEXT,
ADD COLUMN     "token_version" INTEGER NOT NULL DEFAULT 0;
