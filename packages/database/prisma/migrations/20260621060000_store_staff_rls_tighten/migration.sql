-- Migration: tighten store_staff RLS — FORCE + tenant-scoped SELECT
--
-- Finding #3 (MED): store_staff was ENABLE ROW LEVEL SECURITY (no FORCE) with a
-- SELECT policy of USING (true) — meaning any store_admin in their tenant context
-- could read ALL store_staff rows across every tenant, not just their own.
--
-- Two fixes:
--   1. ALTER TABLE ... FORCE ROW LEVEL SECURITY — forces RLS even for table owners
--      so the open-SELECT hole can't be bypassed by owner-role connections.
--   2. Replace USING (true) with a tenant-scoped policy that includes the
--      null-context escape required for auth-time reads.
--
-- WHY THE NULL ESCAPE IS REQUIRED:
--   requireStoreAccess reads store_staff to check whether a staff-role user
--   belongs to the requested store. At that point no tenant GUC is set yet
--   (the middleware hasn't run). A strict `store_id = current_store_id()` policy
--   would return 0 rows when current_store_id() IS NULL, making every staff
--   login return 403. The null-escape (IS NULL OR ...) preserves the auth-time
--   read path while still scoping within-tenant queries to that tenant's rows.
--
-- The existing INSERT and DELETE policies (from 20260616210000_store_staff_write_policies)
-- are left untouched — they already use tenant-scoped WITH CHECK / USING.

-- 1. Force RLS on the table owner as well
ALTER TABLE "store_staff" FORCE ROW LEVEL SECURITY;

-- 2. Drop the open SELECT policy (idempotent)
DROP POLICY IF EXISTS "store_staff_app_select" ON "store_staff";

-- 3. Create tenant-scoped SELECT policy with null-context escape
--    Role `force_app` is the non-owner API role verified in
--    20260615010000_add_staff_role_and_store_staff.
CREATE POLICY "store_staff_app_select"
  ON "store_staff" FOR SELECT
  TO force_app
  USING (
    current_store_id() IS NULL
    OR store_id = current_store_id()
  );
