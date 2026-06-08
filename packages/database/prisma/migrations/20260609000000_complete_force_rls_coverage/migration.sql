-- Complete FORCE RLS coverage + protect bare tenant tables
--
-- Audit finding (2026-06-09): of the public tables, only a subset had RLS
-- ENABLE'd and fewer had FORCE. Production connects as the non-owner
-- `force_app` role (no BYPASSRLS), so ENABLE-without-FORCE is acceptable for
-- the app today — but it is NOT defense-in-depth: any owner/superuser
-- connection (a stray psql, a future role change, a Neon owner query) skips
-- RLS entirely. This migration:
--
--   1. Adds the correct policy to every bare tenant table that had NO RLS.
--   2. FORCEs RLS on every tenant table so isolation holds for ALL roles.
--   3. Leaves genuinely global / user-scoped tables OUT of tenant RLS with a
--      documented reason (locking them behind a store predicate would 0-row
--      the app — see per-table notes).
--
-- ── POLICY IDIOM (hybrid, superset of both existing generations) ──────────
-- FWB has two historical policy shapes:
--   (a) old:  current_store_id() IS NULL OR store_id = current_store_id()
--   (b) new:  store_id = current_setting('app.current_store_id', true)
--             OR current_setting('app.bypass_rls', true) = 'true'
-- withRlsBypass() sets BOTH app.bypass_rls='true' AND app.current_store_id=''
-- so it satisfies both. Some app paths legitimately read these tables with NO
-- tenant context set (the payment webhook at /api/v1/webhooks reads/updates
-- orders + payments without a :storeId and without withRlsBypass — it relies
-- on the old idiom's "context unset => allow" escape). To stay safe for ALL
-- of these access patterns AND remain tenant-correct when context IS set, new
-- policies below use the HYBRID predicate:
--
--   current_store_id() IS NULL                              -- no tenant ctx (webhook, super-admin)
--   OR current_setting('app.bypass_rls', true) = 'true'     -- explicit bypass (Inngest/cron/super-admin)
--   OR store_id = current_store_id()                        -- tenant match
--
-- current_store_id() = NULLIF(current_setting('app.current_store_id',true),'')
-- so it is NULL both when unset AND when withRlsBypass() resets it to ''.
--
-- Idempotent: DROP POLICY IF EXISTS + CREATE; FORCE is a no-op if already set;
-- to_regclass guards skip tables that don't exist in a given environment.

-- Ensure the helper exists (created in 20260404000000; redefined here for
-- environments that applied a squashed history).
CREATE OR REPLACE FUNCTION current_store_id() RETURNS TEXT AS $$
BEGIN
  RETURN NULLIF(current_setting('app.current_store_id', true), '');
EXCEPTION
  WHEN OTHERS THEN RETURN NULL;
END;
$$ LANGUAGE plpgsql STABLE;


-- ═══════════════════════════════════════════════════════════════════════
-- SECTION 1: Bare tenant tables (had NO RLS) — add policy + ENABLE + FORCE
-- ═══════════════════════════════════════════════════════════════════════

-- ── affiliate_events (direct store_id) ──
DROP POLICY IF EXISTS rls_affiliate_events_tenant ON affiliate_events;
ALTER TABLE affiliate_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY rls_affiliate_events_tenant ON affiliate_events
  FOR ALL TO force_app
  USING (
    current_store_id() IS NULL
    OR current_setting('app.bypass_rls', true) = 'true'
    OR store_id::text = current_store_id()
  )
  WITH CHECK (
    current_store_id() IS NULL
    OR current_setting('app.bypass_rls', true) = 'true'
    OR store_id::text = current_store_id()
  );
ALTER TABLE affiliate_events FORCE ROW LEVEL SECURITY;

-- ── bulk_import_jobs (direct store_id) ──
DROP POLICY IF EXISTS rls_bulk_import_jobs_tenant ON bulk_import_jobs;
ALTER TABLE bulk_import_jobs ENABLE ROW LEVEL SECURITY;
CREATE POLICY rls_bulk_import_jobs_tenant ON bulk_import_jobs
  FOR ALL TO force_app
  USING (
    current_store_id() IS NULL
    OR current_setting('app.bypass_rls', true) = 'true'
    OR store_id::text = current_store_id()
  )
  WITH CHECK (
    current_store_id() IS NULL
    OR current_setting('app.bypass_rls', true) = 'true'
    OR store_id::text = current_store_id()
  );
ALTER TABLE bulk_import_jobs FORCE ROW LEVEL SECURITY;

-- ── payment_events (direct store_id) ──
DROP POLICY IF EXISTS rls_payment_events_tenant ON payment_events;
ALTER TABLE payment_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY rls_payment_events_tenant ON payment_events
  FOR ALL TO force_app
  USING (
    current_store_id() IS NULL
    OR current_setting('app.bypass_rls', true) = 'true'
    OR store_id::text = current_store_id()
  )
  WITH CHECK (
    current_store_id() IS NULL
    OR current_setting('app.bypass_rls', true) = 'true'
    OR store_id::text = current_store_id()
  );
ALTER TABLE payment_events FORCE ROW LEVEL SECURITY;

-- ── whatsapp_templates (direct store_id) ──
DROP POLICY IF EXISTS rls_whatsapp_templates_tenant ON whatsapp_templates;
ALTER TABLE whatsapp_templates ENABLE ROW LEVEL SECURITY;
CREATE POLICY rls_whatsapp_templates_tenant ON whatsapp_templates
  FOR ALL TO force_app
  USING (
    current_store_id() IS NULL
    OR current_setting('app.bypass_rls', true) = 'true'
    OR store_id::text = current_store_id()
  )
  WITH CHECK (
    current_store_id() IS NULL
    OR current_setting('app.bypass_rls', true) = 'true'
    OR store_id::text = current_store_id()
  );
ALTER TABLE whatsapp_templates FORCE ROW LEVEL SECURITY;

-- ── cart_items (tenant via carts.cart_id) ──
DROP POLICY IF EXISTS rls_cart_items_tenant ON cart_items;
ALTER TABLE cart_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY rls_cart_items_tenant ON cart_items
  FOR ALL TO force_app
  USING (
    current_store_id() IS NULL
    OR current_setting('app.bypass_rls', true) = 'true'
    OR EXISTS (SELECT 1 FROM carts c WHERE c.id = cart_items.cart_id AND (c.store_id::text = current_store_id() OR current_store_id() IS NULL OR current_setting('app.bypass_rls', true) = 'true'))
  )
  WITH CHECK (
    current_store_id() IS NULL
    OR current_setting('app.bypass_rls', true) = 'true'
    OR EXISTS (SELECT 1 FROM carts c WHERE c.id = cart_items.cart_id AND (c.store_id::text = current_store_id() OR current_store_id() IS NULL OR current_setting('app.bypass_rls', true) = 'true'))
  );
ALTER TABLE cart_items FORCE ROW LEVEL SECURITY;

-- ── order_items (tenant via orders.order_id) ──
DROP POLICY IF EXISTS rls_order_items_tenant ON order_items;
ALTER TABLE order_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY rls_order_items_tenant ON order_items
  FOR ALL TO force_app
  USING (
    current_store_id() IS NULL
    OR current_setting('app.bypass_rls', true) = 'true'
    OR EXISTS (SELECT 1 FROM orders o WHERE o.id = order_items.order_id AND (o.store_id::text = current_store_id() OR current_store_id() IS NULL OR current_setting('app.bypass_rls', true) = 'true'))
  )
  WITH CHECK (
    current_store_id() IS NULL
    OR current_setting('app.bypass_rls', true) = 'true'
    OR EXISTS (SELECT 1 FROM orders o WHERE o.id = order_items.order_id AND (o.store_id::text = current_store_id() OR current_store_id() IS NULL OR current_setting('app.bypass_rls', true) = 'true'))
  );
ALTER TABLE order_items FORCE ROW LEVEL SECURITY;

-- ── return_items (tenant via returns.return_id) ──
DROP POLICY IF EXISTS rls_return_items_tenant ON return_items;
ALTER TABLE return_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY rls_return_items_tenant ON return_items
  FOR ALL TO force_app
  USING (
    current_store_id() IS NULL
    OR current_setting('app.bypass_rls', true) = 'true'
    OR EXISTS (SELECT 1 FROM returns r WHERE r.id = return_items.return_id AND (r.store_id::text = current_store_id() OR current_store_id() IS NULL OR current_setting('app.bypass_rls', true) = 'true'))
  )
  WITH CHECK (
    current_store_id() IS NULL
    OR current_setting('app.bypass_rls', true) = 'true'
    OR EXISTS (SELECT 1 FROM returns r WHERE r.id = return_items.return_id AND (r.store_id::text = current_store_id() OR current_store_id() IS NULL OR current_setting('app.bypass_rls', true) = 'true'))
  );
ALTER TABLE return_items FORCE ROW LEVEL SECURITY;

-- ── payments (tenant via orders.order_id) ──
DROP POLICY IF EXISTS rls_payments_tenant ON payments;
ALTER TABLE payments ENABLE ROW LEVEL SECURITY;
CREATE POLICY rls_payments_tenant ON payments
  FOR ALL TO force_app
  USING (
    current_store_id() IS NULL
    OR current_setting('app.bypass_rls', true) = 'true'
    OR EXISTS (SELECT 1 FROM orders o WHERE o.id = payments.order_id AND (o.store_id::text = current_store_id() OR current_store_id() IS NULL OR current_setting('app.bypass_rls', true) = 'true'))
  )
  WITH CHECK (
    current_store_id() IS NULL
    OR current_setting('app.bypass_rls', true) = 'true'
    OR EXISTS (SELECT 1 FROM orders o WHERE o.id = payments.order_id AND (o.store_id::text = current_store_id() OR current_store_id() IS NULL OR current_setting('app.bypass_rls', true) = 'true'))
  );
ALTER TABLE payments FORCE ROW LEVEL SECURITY;

-- ── product_images (tenant via products.product_id) ──
DROP POLICY IF EXISTS rls_product_images_tenant ON product_images;
ALTER TABLE product_images ENABLE ROW LEVEL SECURITY;
CREATE POLICY rls_product_images_tenant ON product_images
  FOR ALL TO force_app
  USING (
    current_store_id() IS NULL
    OR current_setting('app.bypass_rls', true) = 'true'
    OR EXISTS (SELECT 1 FROM products p WHERE p.id = product_images.product_id AND (p.store_id::text = current_store_id() OR current_store_id() IS NULL OR current_setting('app.bypass_rls', true) = 'true'))
  )
  WITH CHECK (
    current_store_id() IS NULL
    OR current_setting('app.bypass_rls', true) = 'true'
    OR EXISTS (SELECT 1 FROM products p WHERE p.id = product_images.product_id AND (p.store_id::text = current_store_id() OR current_store_id() IS NULL OR current_setting('app.bypass_rls', true) = 'true'))
  );
ALTER TABLE product_images FORCE ROW LEVEL SECURITY;

-- ── product_options (tenant via products.product_id) ──
DROP POLICY IF EXISTS rls_product_options_tenant ON product_options;
ALTER TABLE product_options ENABLE ROW LEVEL SECURITY;
CREATE POLICY rls_product_options_tenant ON product_options
  FOR ALL TO force_app
  USING (
    current_store_id() IS NULL
    OR current_setting('app.bypass_rls', true) = 'true'
    OR EXISTS (SELECT 1 FROM products p WHERE p.id = product_options.product_id AND (p.store_id::text = current_store_id() OR current_store_id() IS NULL OR current_setting('app.bypass_rls', true) = 'true'))
  )
  WITH CHECK (
    current_store_id() IS NULL
    OR current_setting('app.bypass_rls', true) = 'true'
    OR EXISTS (SELECT 1 FROM products p WHERE p.id = product_options.product_id AND (p.store_id::text = current_store_id() OR current_store_id() IS NULL OR current_setting('app.bypass_rls', true) = 'true'))
  );
ALTER TABLE product_options FORCE ROW LEVEL SECURITY;

-- ── product_categories (tenant via products.product_id) ──
DROP POLICY IF EXISTS rls_product_categories_tenant ON product_categories;
ALTER TABLE product_categories ENABLE ROW LEVEL SECURITY;
CREATE POLICY rls_product_categories_tenant ON product_categories
  FOR ALL TO force_app
  USING (
    current_store_id() IS NULL
    OR current_setting('app.bypass_rls', true) = 'true'
    OR EXISTS (SELECT 1 FROM products p WHERE p.id = product_categories.product_id AND (p.store_id::text = current_store_id() OR current_store_id() IS NULL OR current_setting('app.bypass_rls', true) = 'true'))
  )
  WITH CHECK (
    current_store_id() IS NULL
    OR current_setting('app.bypass_rls', true) = 'true'
    OR EXISTS (SELECT 1 FROM products p WHERE p.id = product_categories.product_id AND (p.store_id::text = current_store_id() OR current_store_id() IS NULL OR current_setting('app.bypass_rls', true) = 'true'))
  );
ALTER TABLE product_categories FORCE ROW LEVEL SECURITY;

-- ── product_tags (tenant via products.product_id) ──
DROP POLICY IF EXISTS rls_product_tags_tenant ON product_tags;
ALTER TABLE product_tags ENABLE ROW LEVEL SECURITY;
CREATE POLICY rls_product_tags_tenant ON product_tags
  FOR ALL TO force_app
  USING (
    current_store_id() IS NULL
    OR current_setting('app.bypass_rls', true) = 'true'
    OR EXISTS (SELECT 1 FROM products p WHERE p.id = product_tags.product_id AND (p.store_id::text = current_store_id() OR current_store_id() IS NULL OR current_setting('app.bypass_rls', true) = 'true'))
  )
  WITH CHECK (
    current_store_id() IS NULL
    OR current_setting('app.bypass_rls', true) = 'true'
    OR EXISTS (SELECT 1 FROM products p WHERE p.id = product_tags.product_id AND (p.store_id::text = current_store_id() OR current_store_id() IS NULL OR current_setting('app.bypass_rls', true) = 'true'))
  );
ALTER TABLE product_tags FORCE ROW LEVEL SECURITY;

-- ── product_variants (tenant via products.product_id) ──
DROP POLICY IF EXISTS rls_product_variants_tenant ON product_variants;
ALTER TABLE product_variants ENABLE ROW LEVEL SECURITY;
CREATE POLICY rls_product_variants_tenant ON product_variants
  FOR ALL TO force_app
  USING (
    current_store_id() IS NULL
    OR current_setting('app.bypass_rls', true) = 'true'
    OR EXISTS (SELECT 1 FROM products p WHERE p.id = product_variants.product_id AND (p.store_id::text = current_store_id() OR current_store_id() IS NULL OR current_setting('app.bypass_rls', true) = 'true'))
  )
  WITH CHECK (
    current_store_id() IS NULL
    OR current_setting('app.bypass_rls', true) = 'true'
    OR EXISTS (SELECT 1 FROM products p WHERE p.id = product_variants.product_id AND (p.store_id::text = current_store_id() OR current_store_id() IS NULL OR current_setting('app.bypass_rls', true) = 'true'))
  );
ALTER TABLE product_variants FORCE ROW LEVEL SECURITY;

-- ── wishlist_items (tenant via wishlists.wishlist_id) ──
DROP POLICY IF EXISTS rls_wishlist_items_tenant ON wishlist_items;
ALTER TABLE wishlist_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY rls_wishlist_items_tenant ON wishlist_items
  FOR ALL TO force_app
  USING (
    current_store_id() IS NULL
    OR current_setting('app.bypass_rls', true) = 'true'
    OR EXISTS (SELECT 1 FROM wishlists w WHERE w.id = wishlist_items.wishlist_id AND (w.store_id::text = current_store_id() OR current_store_id() IS NULL OR current_setting('app.bypass_rls', true) = 'true'))
  )
  WITH CHECK (
    current_store_id() IS NULL
    OR current_setting('app.bypass_rls', true) = 'true'
    OR EXISTS (SELECT 1 FROM wishlists w WHERE w.id = wishlist_items.wishlist_id AND (w.store_id::text = current_store_id() OR current_store_id() IS NULL OR current_setting('app.bypass_rls', true) = 'true'))
  );
ALTER TABLE wishlist_items FORCE ROW LEVEL SECURITY;

-- ── product_option_values (tenant via 2-hop join) ──
DROP POLICY IF EXISTS rls_product_option_values_tenant ON product_option_values;
ALTER TABLE product_option_values ENABLE ROW LEVEL SECURITY;
CREATE POLICY rls_product_option_values_tenant ON product_option_values
  FOR ALL TO force_app
  USING (
    current_store_id() IS NULL
    OR current_setting('app.bypass_rls', true) = 'true'
    OR EXISTS (SELECT 1 FROM product_options po JOIN products p ON p.id=po.product_id WHERE po.id=product_option_values.option_id AND (p.store_id::text=current_setting('app.current_store_id',true) OR p.store_id=current_store_id() OR current_store_id() IS NULL OR current_setting('app.bypass_rls',true)='true'))
  )
  WITH CHECK (
    current_store_id() IS NULL
    OR current_setting('app.bypass_rls', true) = 'true'
    OR EXISTS (SELECT 1 FROM product_options po JOIN products p ON p.id=po.product_id WHERE po.id=product_option_values.option_id AND (p.store_id::text=current_setting('app.current_store_id',true) OR p.store_id=current_store_id() OR current_store_id() IS NULL OR current_setting('app.bypass_rls',true)='true'))
  );
ALTER TABLE product_option_values FORCE ROW LEVEL SECURITY;

-- ── product_variant_options (tenant via 2-hop join) ──
DROP POLICY IF EXISTS rls_product_variant_options_tenant ON product_variant_options;
ALTER TABLE product_variant_options ENABLE ROW LEVEL SECURITY;
CREATE POLICY rls_product_variant_options_tenant ON product_variant_options
  FOR ALL TO force_app
  USING (
    current_store_id() IS NULL
    OR current_setting('app.bypass_rls', true) = 'true'
    OR EXISTS (SELECT 1 FROM product_variants pv JOIN products p ON p.id=pv.product_id WHERE pv.id=product_variant_options.variant_id AND (p.store_id::text=current_setting('app.current_store_id',true) OR p.store_id=current_store_id() OR current_store_id() IS NULL OR current_setting('app.bypass_rls',true)='true'))
  )
  WITH CHECK (
    current_store_id() IS NULL
    OR current_setting('app.bypass_rls', true) = 'true'
    OR EXISTS (SELECT 1 FROM product_variants pv JOIN products p ON p.id=pv.product_id WHERE pv.id=product_variant_options.variant_id AND (p.store_id::text=current_setting('app.current_store_id',true) OR p.store_id=current_store_id() OR current_store_id() IS NULL OR current_setting('app.bypass_rls',true)='true'))
  );
ALTER TABLE product_variant_options FORCE ROW LEVEL SECURITY;

-- ═══════════════════════════════════════════════════════════════════════
-- SECTION 2: ENABLE'd-but-not-FORCED tenant tables — add FORCE (policy already
-- exists from prior migrations; FORCE only affects owner/superuser roles).
-- Also re-FORCEs the 4 tables the 20260530 migration missed because it listed
-- non-existent names (anomalies->profit_anomalies, dead_stock_flags->
-- deadstock_flags, inventory_logs->inventory_history, notifications [no table]).
-- ═══════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  t text;
  tables text[] := ARRAY[
    'abandoned_cart_configs',
    'abandoned_carts',
    'affiliate_configs',
    'affiliate_payouts',
    'affiliate_referrals',
    'affiliates',
    'ai_recommendation',
    'ai_usage',
    'audit_logs',
    'bulk_ai_jobs',
    'customer_cohort_snapshots',
    'customer_rfm_snapshots',
    'deadstock_flags',
    'frequently_bought_together',
    'funnel_snapshots',
    'inventory_history',
    'journal_lines',
    'loyalty_points',
    'loyalty_transactions',
    'newsletter_subscribers',
    'notification_configs',
    'notification_event_configs',
    'notification_logs',
    'payment_configs',
    'product_faqs',
    'product_relations',
    'profit_anomalies',
    'push_subscriptions',
    'reorder_rules',
    'sequences',
    'shipping_carrier_configs',
    'shipping_zones',
    'store_faqs',
    'store_features',
    'store_howtos',
    'store_pages',
    'tags',
    'tax_rates'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    IF to_regclass(format('public.%I', t)) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    END IF;
  END LOOP;
END $$;

-- ═══════════════════════════════════════════════════════════════════════
-- SECTION 3: Tables intentionally LEFT WITHOUT tenant RLS (documented)
-- ═══════════════════════════════════════════════════════════════════════
-- USER-SCOPED auth/identity tables — isolation is enforced at the user-auth
-- layer (the JWT user id), NOT the store boundary. They are read heavily
-- OUTSIDE any tenant context (login, token refresh, email verification). A
-- store predicate would 0-row auth. Same precedent the codebase already set
-- for onesignal_subscriptions in 20260522000000.
--   * users                 -- store_id is NULL for admin/super_admin; auth lookups are contextless
--   * addresses             -- user_id FK; account-level, not store-level
--   * customer_addresses    -- customer_id FK; account-level
--   * refresh_tokens        -- user_id FK; rotated during contextless /auth/refresh
--   * verification_tokens   -- user_id FK; consumed during contextless verify/reset
--   * onesignal_subscriptions -- user_id FK (already excluded by 20260522000000)
--
-- GLOBAL / ROOT tables:
--   * stores          -- the tenant ROOT. Resolved by slug/domain in
--                        store-access.ts BEFORE any tenant GUC is set; a tenant
--                        predicate here would break store resolution + login.
--                        (The 20260530 migration FORCE'd it but it has NO
--                        policy, which under FORCE = deny-all for force_app.
--                        We DROP that FORCE to keep store resolution working.)
--   * system_settings -- platform-global config, no store_id, no tenant meaning.

-- Undo the unsafe FORCE on `stores` (FORCE + no policy = deny-all for the app
-- role). stores must remain readable for slug/domain resolution.
ALTER TABLE stores NO FORCE ROW LEVEL SECURITY;
ALTER TABLE stores DISABLE ROW LEVEL SECURITY;

