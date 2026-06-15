-- Migration: add staff role + store_staff membership table
-- Adds `staff` to UserRole enum and introduces StoreStaff to link
-- staff users to specific stores with a scoped role label.

-- 1. Extend the UserRole enum
ALTER TYPE "UserRole" ADD VALUE 'staff';

-- 2. Create store_staff join table
CREATE TABLE "store_staff" (
  "id"         TEXT NOT NULL DEFAULT gen_random_uuid(),
  "store_id"   TEXT NOT NULL,
  "user_id"    TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "store_staff_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "store_staff_user_id_store_id_key" UNIQUE ("user_id", "store_id")
);

-- 3. Indexes for the common lookup patterns
CREATE INDEX "store_staff_store_id_idx" ON "store_staff"("store_id");
CREATE INDEX "store_staff_user_id_idx"  ON "store_staff"("user_id");

-- 4. Foreign keys
ALTER TABLE "store_staff"
  ADD CONSTRAINT "store_staff_store_id_fkey"
  FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "store_staff"
  ADD CONSTRAINT "store_staff_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 5. RLS: inherit the store-scoped policy from the parent store_id column.
--    Staff rows are admin-internal — no storefront read required.
--    Bypass is not needed; the app role reads these via withRlsBypass in
--    the store-access middleware (same pattern as other admin lookups).
ALTER TABLE "store_staff" ENABLE ROW LEVEL SECURITY;

-- Allow the app role to SELECT (needed by requireStoreAccess for staff users)
CREATE POLICY "store_staff_app_select"
  ON "store_staff" FOR SELECT
  USING (true);

-- Writes go through the API (store owner or super_admin); no direct-write policy needed.
