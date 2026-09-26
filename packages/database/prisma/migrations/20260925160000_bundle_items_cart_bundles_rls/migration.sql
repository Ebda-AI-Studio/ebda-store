-- Follow-up to 20260906120000_product_bundles (#1564).
--
-- That migration's own comment claimed "bundle_items and cart_bundles get no
-- RLS: neither carries store_id, and both are reachable only via an
-- RLS-protected parent (bundles / carts), the same call already made for
-- cart_items." That comment is FALSE: 20260609000000_complete_force_rls_
-- coverage gives cart_items (and order_items, return_items) the exact
-- opposite treatment — a parent-join `FOR ALL` policy, not "no RLS because a
-- parent has RLS". A child row reached only through an RLS-protected parent
-- is not itself protected: any query that reads bundle_items/cart_bundles
-- directly (a raw SQL join, a future admin report, a bug that bypasses the
-- ORM's normal parent-scoped fetch) sees every store's rows.
--
-- This migration gives bundle_items and cart_bundles the SAME parent-join
-- `FOR ALL` policy shape as cart_items/order_items/return_items, resolving
-- store_id through their real parent (bundles.store_id / carts.store_id).
-- Not editing 20260906120000's SQL file: it has already been applied in
-- production, and Prisma's migrate-deploy checksum would flag any edit to an
-- applied migration.sql as drift on the next deploy — a false "migration
-- modified" failure on a file whose DDL never actually changed. The
-- correction lives here, and in the comment above.
--
-- Deliberately NOT retroactive DML: both tables are brand new (this PR),
-- have not shipped to any live store (bundles/D-series feature is unreleased
-- product), and RLS is purely a read/write policy — no data changes.

-- ── bundle_items (tenant via bundles.bundle_id) ──
DROP POLICY IF EXISTS rls_bundle_items_tenant ON bundle_items;
ALTER TABLE bundle_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY rls_bundle_items_tenant ON bundle_items
  FOR ALL TO force_app
  USING (
    current_store_id() IS NULL
    OR current_setting('app.bypass_rls', true) = 'true'
    OR EXISTS (
      SELECT 1 FROM bundles b
      WHERE b.id = bundle_items.bundle_id
        AND (b.store_id = current_store_id() OR current_store_id() IS NULL OR current_setting('app.bypass_rls', true) = 'true')
    )
  )
  WITH CHECK (
    current_store_id() IS NULL
    OR current_setting('app.bypass_rls', true) = 'true'
    OR EXISTS (
      SELECT 1 FROM bundles b
      WHERE b.id = bundle_items.bundle_id
        AND (b.store_id = current_store_id() OR current_store_id() IS NULL OR current_setting('app.bypass_rls', true) = 'true')
    )
  );
ALTER TABLE bundle_items FORCE ROW LEVEL SECURITY;

-- ── cart_bundles (tenant via carts.cart_id) ──
DROP POLICY IF EXISTS rls_cart_bundles_tenant ON cart_bundles;
ALTER TABLE cart_bundles ENABLE ROW LEVEL SECURITY;
CREATE POLICY rls_cart_bundles_tenant ON cart_bundles
  FOR ALL TO force_app
  USING (
    current_store_id() IS NULL
    OR current_setting('app.bypass_rls', true) = 'true'
    OR EXISTS (
      SELECT 1 FROM carts c
      WHERE c.id = cart_bundles.cart_id
        AND (c.store_id::text = current_store_id() OR current_store_id() IS NULL OR current_setting('app.bypass_rls', true) = 'true')
    )
  )
  WITH CHECK (
    current_store_id() IS NULL
    OR current_setting('app.bypass_rls', true) = 'true'
    OR EXISTS (
      SELECT 1 FROM carts c
      WHERE c.id = cart_bundles.cart_id
        AND (c.store_id::text = current_store_id() OR current_store_id() IS NULL OR current_setting('app.bypass_rls', true) = 'true')
    )
  );
ALTER TABLE cart_bundles FORCE ROW LEVEL SECURITY;
