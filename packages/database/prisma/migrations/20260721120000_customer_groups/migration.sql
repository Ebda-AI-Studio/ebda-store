-- Migration: customer_groups
--
-- Merchant-defined customer segments ("Wholesale", "VIP"), plus an optional
-- `customers.group_id` pointing at one.
--
-- Why: group-scoped pricing and promotion/coupon targeting both need a manual,
-- merchant-controlled segment. FWB had no equivalent — `customer_rfm_snapshots`
-- is *computed* analytics, not an assignable group. This is the dependency root
-- for the promotions engine and coupon targeting work.
--
-- Design choices:
--   • `group_id` on customers is nullable with ON DELETE SET NULL — deleting a
--     group must never delete customers. (Cascade here would be a data-loss bug:
--     a merchant tidying up segments would silently destroy customer records.)
--   • `is_default` marks the group new customers fall into. At most one per
--     store, enforced by a PARTIAL unique index — Prisma cannot express a
--     filtered unique index, so it lives here and only here.
--   • `is_active` hides a group from pickers/targeting without unassigning its
--     members, so deactivating is reversible.
--   • UNIQUE (store_id, name) keeps group names unambiguous inside a store
--     while letting different stores reuse the same names.
--
-- RLS: customer_groups is tenant data. Policies use the canonical 3-branch
-- hybrid predicate copied verbatim from
-- 20260609000000_complete_force_rls_coverage — `current_store_id() IS NULL`
-- (contextless/cron read) OR bypass_rls='true' OR store_id matches.
-- One policy PER COMMAND: Postgres restrictively denies any command with zero
-- matching policy, so a missing FOR INSERT policy is a silent deny-all under
-- the non-bypass force_app role (see 20260716000100_store_staff_update_policy
-- for that exact failure).
--
-- Note the bypass value is 'true', NOT 'on' — the 'on' typo shipped once in
-- 20260622100000_product_daily_views and deny-alled every write until
-- 20260716000000 fixed it.
--
-- FORCE ROW LEVEL SECURITY is set so the policies apply to the table owner too,
-- matching every other tenant table after 20260609000000.

CREATE TABLE "customer_groups" (
  "id"         TEXT         NOT NULL,
  "store_id"   TEXT         NOT NULL,
  "name"       TEXT         NOT NULL,
  "name_ar"    TEXT,
  "is_active"  BOOLEAN      NOT NULL DEFAULT true,
  "is_default" BOOLEAN      NOT NULL DEFAULT false,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "customer_groups_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "customer_groups_store_id_fkey"
    FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "customer_groups_store_id_name_key"
  ON "customer_groups" ("store_id", "name");

CREATE INDEX "customer_groups_store_id_is_active_idx"
  ON "customer_groups" ("store_id", "is_active");

-- At most one default group per store. Partial unique index: rows with
-- is_default = false are not constrained.
CREATE UNIQUE INDEX "customer_groups_one_default_per_store"
  ON "customer_groups" ("store_id")
  WHERE "is_default";

-- ── customers.group_id ────────────────────────────────────────────────────────
ALTER TABLE "customers" ADD COLUMN "group_id" TEXT;

ALTER TABLE "customers"
  ADD CONSTRAINT "customers_group_id_fkey"
  FOREIGN KEY ("group_id") REFERENCES "customer_groups"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "customers_store_id_group_id_idx"
  ON "customers" ("store_id", "group_id");

-- ── RLS ───────────────────────────────────────────────────────────────────────
ALTER TABLE "customer_groups" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "customer_groups" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "customer_groups_app_select" ON "customer_groups";
CREATE POLICY "customer_groups_app_select"
  ON "customer_groups" FOR SELECT
  USING (
    current_store_id() IS NULL
    OR current_setting('app.bypass_rls', true) = 'true'
    OR store_id = current_store_id()
  );

DROP POLICY IF EXISTS "customer_groups_app_insert" ON "customer_groups";
CREATE POLICY "customer_groups_app_insert"
  ON "customer_groups" FOR INSERT
  WITH CHECK (
    current_store_id() IS NULL
    OR current_setting('app.bypass_rls', true) = 'true'
    OR store_id = current_store_id()
  );

DROP POLICY IF EXISTS "customer_groups_app_update" ON "customer_groups";
CREATE POLICY "customer_groups_app_update"
  ON "customer_groups" FOR UPDATE
  USING (
    current_store_id() IS NULL
    OR current_setting('app.bypass_rls', true) = 'true'
    OR store_id = current_store_id()
  )
  WITH CHECK (
    current_store_id() IS NULL
    OR current_setting('app.bypass_rls', true) = 'true'
    OR store_id = current_store_id()
  );

DROP POLICY IF EXISTS "customer_groups_app_delete" ON "customer_groups";
CREATE POLICY "customer_groups_app_delete"
  ON "customer_groups" FOR DELETE
  USING (
    current_store_id() IS NULL
    OR current_setting('app.bypass_rls', true) = 'true'
    OR store_id = current_store_id()
  );
