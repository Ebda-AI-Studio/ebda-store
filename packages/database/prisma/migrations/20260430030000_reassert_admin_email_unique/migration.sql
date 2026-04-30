-- Re-assert the partial unique index that keeps admin emails globally
-- unique. Created originally in 20260427000000_tenant_scoped_user_auth,
-- but Prisma's `@@unique` syntax can't express the WHERE clause, so
-- the schema doesn't know this constraint exists. That makes
-- `prisma migrate dev` propose dropping the index on every diff —
-- one wrong "y" at the prompt and a future admin re-registration
-- could create a duplicate (storeId IS NULL, email='x@y') that breaks
-- login (which uses findFirst across the global admin namespace).
--
-- This migration is idempotent: `IF NOT EXISTS` lets it co-exist with
-- the original creation, and re-runs noop. Keep this file alongside
-- any future Prisma-generated migration that touches `users` so the
-- constraint always survives.
CREATE UNIQUE INDEX IF NOT EXISTS "users_admin_email_key"
  ON "users"("email")
  WHERE "store_id" IS NULL;
