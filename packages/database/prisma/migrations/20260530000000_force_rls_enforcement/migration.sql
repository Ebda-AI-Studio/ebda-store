-- F1: Force RLS enforcement so tenant isolation holds even for the table owner.
--
-- Background: migration 20260521000000_fix_rls_bypass_policies already removed
-- the implicit escape clause, so the tenant_isolation policies are fail-closed
-- in their USING clause. BUT Postgres does NOT apply RLS to a table's OWNER
-- role unless the table is set to FORCE ROW LEVEL SECURITY. In production the
-- app currently connects as `neondb_owner`, which owns these tables, so RLS is
-- effectively INERT for it -- every policy is skipped and cross-tenant reads
-- are possible.
--
-- This migration sets FORCE ROW LEVEL SECURITY on every tenant-scoped table so
-- the policies apply regardless of which role connects. Combined with the
-- boot-time role assertion (apps/api/src/index.ts) and the manual move to the
-- non-owner `force_app` role, this makes tenant isolation defense-in-depth.
--
-- Idempotent: FORCE ROW LEVEL SECURITY is a no-op if already set; tables that
-- do not exist are skipped via the to_regclass guard so this is safe to apply
-- on any environment regardless of which optional tables were created.

DO $$
DECLARE
  t text;
  tables text[] := ARRAY[
    'stores','products','product_variants','orders','order_items','categories',
    'product_categories','customers','carts','cart_items','coupons','reviews',
    'addresses','payments','inventory_logs','wishlists','wishlist_items',
    'blog_posts','notifications','journal_entries','accounts','expenses',
    'purchase_orders','purchase_order_items','stock_adjustments',
    'stock_adjustment_items','suppliers','reorder_suggestions',
    'dead_stock_flags','anomalies','returns','return_items','shipments',
    'backorder_lines'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    IF to_regclass(format('public.%I', t)) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    END IF;
  END LOOP;
END $$;
