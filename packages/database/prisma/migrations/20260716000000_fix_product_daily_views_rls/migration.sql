-- Migration: fix_product_daily_views_rls
--
-- product_daily_views shipped in 20260622100000_product_daily_views with
-- INSERT/UPDATE policies checking
-- `current_setting('app.bypass_rls', true) = 'on'` — the app only ever sets
-- this GUC to 'true' (view-ingest.service.ts:99-107, and every other
-- withRlsBypass call site across the codebase), so under the non-bypass
-- force_app role (RLS cutover) these two policies deny-all: every
-- product-view write 42501s and is silently swallowed by
-- view-ingest.service.ts's fail-open catch block. The SELECT policy has the
-- same 'on' typo on its bypass branch AND no `current_store_id() IS NULL`
-- escape, so a contextless/bypass read (cron, analytics rollup via
-- analytics-rollup.service.ts) also silently returns 0 rows instead of
-- erroring. There was never a DELETE policy at all (deny-all by omission —
-- no code path deletes today, but this closes the gap for symmetry/future use).
--
-- product_daily_views is RLS-ENABLED but NOT FORCED, and prod currently
-- connects as the BYPASSRLS `neondb_owner` role, so RLS policies are not
-- enforced today regardless of their content — this migration is CORRECT
-- BUT BEHAVIORALLY INERT until the RLS cutover flips DATABASE_URL to the
-- non-bypass `force_app` role (docs/plans/2026-07-02-rls-cutover.md).
--
-- Predicate: copies the canonical HYB shape verbatim from
-- 20260609000000_complete_force_rls_coverage/migration.sql (the
-- `current_store_id() IS NULL OR bypass_rls='true' OR store_id=current_store_id()`
-- 3-branch hybrid) rather than inventing a new shape. `current_store_id()`
-- is `NULLIF(current_setting('app.current_store_id',true),'')`, defined in
-- 20260404000000_add_rls_policies and redefined in later migrations for
-- squashed-history environments — already present by the time this runs.
--
-- Idempotent: DROP POLICY IF EXISTS + CREATE for every policy touched.

-- ── SELECT: fix 'on' typo, add null-context (contextless/bypass read) escape ──
DROP POLICY IF EXISTS "product_daily_views_store_select" ON "product_daily_views";
CREATE POLICY "product_daily_views_store_select"
  ON "product_daily_views"
  FOR SELECT
  USING (
    current_store_id() IS NULL
    OR current_setting('app.bypass_rls', true) = 'true'
    OR store_id = current_store_id()
  );

-- ── INSERT: fix 'on' typo, add null-context escape + tenant-match branch ──
DROP POLICY IF EXISTS "product_daily_views_store_insert" ON "product_daily_views";
CREATE POLICY "product_daily_views_store_insert"
  ON "product_daily_views"
  FOR INSERT
  WITH CHECK (
    current_store_id() IS NULL
    OR current_setting('app.bypass_rls', true) = 'true'
    OR store_id = current_store_id()
  );

-- ── UPDATE: fix 'on' typo, add null-context escape + tenant-match branch ──
DROP POLICY IF EXISTS "product_daily_views_store_update" ON "product_daily_views";
CREATE POLICY "product_daily_views_store_update"
  ON "product_daily_views"
  FOR UPDATE
  USING (
    current_store_id() IS NULL
    OR current_setting('app.bypass_rls', true) = 'true'
    OR store_id = current_store_id()
  );

-- ── DELETE: never existed — add with the same HYB predicate for symmetry ──
DROP POLICY IF EXISTS "product_daily_views_store_delete" ON "product_daily_views";
CREATE POLICY "product_daily_views_store_delete"
  ON "product_daily_views"
  FOR DELETE
  USING (
    current_store_id() IS NULL
    OR current_setting('app.bypass_rls', true) = 'true'
    OR store_id = current_store_id()
  );
