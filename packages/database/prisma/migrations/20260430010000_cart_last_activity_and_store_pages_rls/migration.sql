-- Two drift fixes the audit caught.
--
-- 1. carts.last_activity_at + index — declared in schema.prisma since the
--    abandoned-cart cron landed but never created by any migration.
--    Production has it (added via `prisma db push` at some point); a fresh
--    CI / dev DB crashes the moment cart.service writes to it. Idempotent
--    `IF NOT EXISTS` so prod is a no-op.
--
-- 2. store_pages added in 20260428100000 AFTER 20260404000000_add_rls_policies
--    ran. The RLS-enable list in that migration is hardcoded; new tables
--    aren't picked up. CMS pages were created without tenant isolation at
--    the database layer. Mirror the `current_store_id IS NULL OR store_id =
--    current_store_id()` policy used for every other store-scoped table.

ALTER TABLE "carts"
  ADD COLUMN IF NOT EXISTS "last_activity_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Backfill any pre-existing rows so the abandoned-cart cron sees a real
-- value for them — `updated_at` is the closest stand-in we have.
UPDATE "carts" SET "last_activity_at" = "updated_at" WHERE "last_activity_at" IS NULL;

CREATE INDEX IF NOT EXISTS "carts_last_activity_at_idx" ON "carts"("last_activity_at");

-- store_pages RLS
ALTER TABLE "store_pages" ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'store_pages'
      AND policyname = 'rls_store_pages_tenant'
  ) THEN
    CREATE POLICY rls_store_pages_tenant ON store_pages
      FOR ALL TO force_app
      USING (current_store_id() IS NULL OR store_id = current_store_id())
      WITH CHECK (current_store_id() IS NULL OR store_id = current_store_id());
  END IF;
END
$$;
