-- Migration: store_staff_update_policy
--
-- store_staff has SELECT (20260621060000_store_staff_rls_tighten), INSERT and
-- DELETE (20260616210000_store_staff_write_policies) policies, but no `FOR
-- UPDATE` policy was ever created — Postgres restrictively denies every
-- UPDATE with zero matching policy, so an UPDATE on store_staff under the
-- non-bypass `force_app` role (RLS cutover) would 42501. Grep confirms no
-- current code path updates store_staff (only create/delete via
-- staff.routes.ts), so this is latent, not live — added for symmetry with
-- the table's other three commands and to close the gap before a future
-- "change staff role" write path is added.
--
-- store_staff is RLS-ENABLED and FORCED (20260621060000), and prod
-- currently connects as the BYPASSRLS `neondb_owner` role, so this is
-- CORRECT BUT BEHAVIORALLY INERT until the RLS cutover flips DATABASE_URL
-- to the non-bypass `force_app` role.
--
-- Predicate: copies the exact HYB shape + branch order used by this table's
-- own sibling INSERT/DELETE policies
-- (20260616210000_store_staff_write_policies/migration.sql) rather than the
-- alternate branch order used elsewhere — keeps all four store_staff
-- policies textually consistent.
--
-- Idempotent: DROP POLICY IF EXISTS + CREATE.

DROP POLICY IF EXISTS "store_staff_app_update" ON "store_staff";
CREATE POLICY "store_staff_app_update"
  ON "store_staff" FOR UPDATE
  USING (
    current_setting('app.bypass_rls', true) = 'true'
    OR current_store_id() IS NULL
    OR store_id::text = current_store_id()
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'true'
    OR current_store_id() IS NULL
    OR store_id::text = current_store_id()
  );
