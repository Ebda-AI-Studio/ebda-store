-- Fix: store_staff INSERT/DELETE were silently denied → 500 on "Add staff member".
--
-- 20260615010000_add_staff_role_and_store_staff enabled RLS on store_staff with
-- ONLY a SELECT policy ("no direct-write policy needed"). That was wrong: the API
-- connects as the non-owner, non-BYPASSRLS role `force_app`, for which RLS is
-- always enforced. With no INSERT/DELETE policy, Postgres restrictively DENIES
-- every write (error 42501) — including the staff.routes.ts create/delete paths
-- that ARE already wrapped in withRlsBypass(). withRlsBypass sets
-- `SET LOCAL app.bypass_rls = 'true'`, but a GUC only matters if a policy reads
-- it; there was no write policy to read it. Result: creating a staff account 500s.
--
-- Add INSERT + DELETE policies that honor the bypass GUC. All store_staff writes
-- go through withRlsBypass in staff.routes.ts (behind authenticate + authorize +
-- requireStoreAccess), so gating on app.bypass_rls documents that contract while
-- still letting a future store-scoped write succeed when tenant context is set.

CREATE POLICY "store_staff_app_insert"
  ON "store_staff" FOR INSERT
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'true'
    OR current_store_id() IS NULL
    OR store_id::text = current_store_id()
  );

CREATE POLICY "store_staff_app_delete"
  ON "store_staff" FOR DELETE
  USING (
    current_setting('app.bypass_rls', true) = 'true'
    OR current_store_id() IS NULL
    OR store_id::text = current_store_id()
  );
