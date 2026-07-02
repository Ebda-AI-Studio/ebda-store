-- RLS cutover Phase 1b — close every remaining deny-all-at-cutover table.
--
-- Background: docs/audits/2026-07-02-tenancy-rls-auth.md (F3) + the cutover
-- plan docs/plans/2026-07-02-rls-cutover.md (Phase 0.3 / 1b). The 2026-04-04
-- migration explicitly EXCLUDED `payments, return_items, system_settings,
-- addresses, wishlist_items` from tenant policies (see its closing comment).
-- The 2026-06-09 "complete FORCE RLS coverage" migration already closed
-- THREE of those five — `payments`, `return_items`, and `wishlist_items` all
-- got a correct store-derived policy (via their parent order/return/wishlist)
-- + ENABLE + FORCE. This migration verifies that and does NOT touch them
-- again (they already pass the Phase-0 "deny-all" query below).
--
-- Two tables were left incomplete:
--
--   1. `addresses` — FORCE ROW LEVEL SECURITY was set by
--      20260530000000_force_rls_enforcement (it's in that migration's FORCE
--      array), but `addresses` was NEVER given ENABLE ROW LEVEL SECURITY or
--      any policy. FORCE alone (relforcerowsecurity=true) has NO effect
--      while relrowsecurity=false — so today `addresses` has ZERO row
--      filtering for anyone (open, not deny-all). The moment someone runs
--      ENABLE ROW LEVEL SECURITY on it (which we do here, to finally give it
--      a real per-user backstop) WITHOUT also adding a policy in the SAME
--      transaction, it would flip to deny-all for `force_app` and every
--      superuser/owner connection too (FORCE already set). So ENABLE and the
--      policy ship together, atomically, in this migration.
--      `addresses` is user-scoped (FK `user_id`, no `store_id` — see
--      schema.prisma model Address), so it needs a NEW predicate shape: a
--      per-user hybrid identical in spirit to the existing per-store hybrid.
--
--   2. `system_settings` — never had RLS enabled at all (no store_id column,
--      genuinely platform-global config). Per Phase 0.3, we ENABLE + FORCE +
--      add an intentionally-permissive `USING (true)` policy so it is
--      explicitly governed (not silently ungoverned) without restricting
--      access — this table has no tenant meaning to restrict by.
--
-- current_user_id() mirrors current_store_id() (added 20260404000000): reads
-- the `app.current_user_id` GUC set by runInTenantContext (packages/database/
-- src/index.ts) and the tenant-context.ts middleware from req.user?.userId.
-- Additive: when unset (NULL), the hybrid predicate below allows all rows —
-- IDENTICAL to today's behavior (addresses currently has no filtering at
-- all). Only once app.current_user_id is actually set for a given request
-- AND the connecting role is non-bypass (force_app) does this become a real
-- per-user backstop.
--
-- Inert on the current bypass role (`neondb_owner`, BYPASSRLS): a BYPASSRLS
-- role skips every RLS check regardless of ENABLE/FORCE/policy, so none of
-- this changes prod behavior until the Phase 3 cutover flips DATABASE_URL to
-- force_app.
--
-- Idempotent: CREATE OR REPLACE FUNCTION, DROP POLICY IF EXISTS + CREATE
-- POLICY, and ENABLE/FORCE ROW LEVEL SECURITY are all safe to re-run or to
-- apply on an environment where this already partially landed.

-- ── current_user_id(): mirrors current_store_id() ──────────────────────────
CREATE OR REPLACE FUNCTION current_user_id() RETURNS TEXT AS $$
BEGIN
  RETURN NULLIF(current_setting('app.current_user_id', true), '');
EXCEPTION
  WHEN OTHERS THEN RETURN NULL;
END;
$$ LANGUAGE plpgsql STABLE;

-- ── addresses: user-scoped hybrid policy (B-user) ───────────────────────────
-- FORCE was already set by 20260530000000_force_rls_enforcement; ENABLE +
-- the policy land together here so the table is never deny-all at any point
-- in this migration's execution.
DROP POLICY IF EXISTS rls_addresses_user ON addresses;
CREATE POLICY rls_addresses_user ON addresses
  FOR ALL TO force_app
  USING (
    current_user_id() IS NULL
    OR current_setting('app.bypass_rls', true) = 'true'
    OR user_id = current_user_id()
  )
  WITH CHECK (
    current_user_id() IS NULL
    OR current_setting('app.bypass_rls', true) = 'true'
    OR user_id = current_user_id()
  );
ALTER TABLE addresses ENABLE ROW LEVEL SECURITY;
ALTER TABLE addresses FORCE ROW LEVEL SECURITY;

-- ── system_settings: platform-global, intentionally NOT tenant-scoped ───────
-- No store_id / user_id column exists on this table — it's platform config
-- (feature flags, global defaults). USING(true) means the policy never
-- restricts anything; it exists so the table is explicitly governed (and so
-- a future accidental `ENABLE ROW LEVEL SECURITY` elsewhere with no policy
-- can't silently deny-all it) rather than left in an ungoverned state.
DROP POLICY IF EXISTS rls_system_settings_global ON system_settings;
CREATE POLICY rls_system_settings_global ON system_settings
  FOR ALL TO force_app
  USING (true)
  WITH CHECK (true);
ALTER TABLE system_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE system_settings FORCE ROW LEVEL SECURITY;

-- ── Verification note (not executable) ──────────────────────────────────────
-- After this migration, the Phase-0 discovery query from
-- docs/plans/2026-07-02-rls-cutover.md should return ZERO rows:
--
--   SELECT c.relname
--   FROM pg_class c
--   JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
--   LEFT JOIN pg_policy p ON p.polrelid = c.oid
--   WHERE c.relkind = 'r' AND c.relrowsecurity
--   GROUP BY 1
--   HAVING COUNT(p.polname) = 0;
--
-- `payments`, `return_items`, `wishlist_items` are not touched here — they
-- already carry a correct force_app policy from 20260609000000 and are
-- exercised by the new force_app CI job (tests/integration/rls-force-app.test.ts)
-- alongside the two tables this migration adds.
