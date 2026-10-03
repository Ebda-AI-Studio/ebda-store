-- SP4 Stage 1a (R-EBDA-001): STRICT row-level security for the `ebda_app` role.
--
-- Binding design: docs/ebda/design/cloudflare-backend.md section 3.
--
-- What this migration does
--   1. creates the runtime role `ebda_app` (NOLOGIN here; ops sets LOGIN and the
--      password per environment) with NOSUPERUSER NOBYPASSRLS and only the
--      grants the API needs (no TRUNCATE, no DDL, no _prisma_migrations);
--   2. ENABLEs and FORCEs RLS on every table below and replaces ALL of FWB's
--      policies (hybrid "allow-contextless", strict, bypass-GUC, role-less) with
--      ONE policy per table for ebda_app. A query that has not set
--      `app.current_store_id` (transaction-locally) sees no rows and cannot
--      write: there is no `IS NULL` allowance and no `app.bypass_rls` path;
--   3. adds the narrow SECURITY DEFINER functions that replace the bypass GUC
--      for the lookups that must run before a store or user is known.
--
-- The store predicate is
--     store_id = nullif(current_setting('app.current_store_id', true), '')
-- compared as TEXT: every id column in this schema is TEXT (Prisma `@db.Text`
-- uuid strings), so `::uuid` would not type-check against store_id.
-- A NULL on either side compares as NULL, i.e. false, so an unset GUC reads no
-- rows and a write is rejected by WITH CHECK.
--
-- The owner running this migration must bypass RLS by itself (superuser or
-- BYPASSRLS): FORCE RLS applies to the owner too and no policy names it, and
-- the definer functions rely on that. Section 0 refuses to continue otherwise.
--
-- =============================================================================
-- TABLES WITH A store_id COLUMN (85 incl. users and store_staff; policy: store_id = store GUC)
--   enumerated from information_schema.columns on 2026-10-04 (column store_id)
--   abandoned_cart_configs
--   abandoned_carts
--   accounts
--   affiliate_configs
--   affiliate_events
--   affiliate_payouts
--   affiliate_referrals
--   affiliates
--   ai_recommendation
--   ai_usage
--   answer_engine_checks
--   audit_logs  [store_id NULLABLE: NULL rows are unreachable for ebda_app]
--   backorder_lines
--   bank_statements
--   bank_transactions
--   blog_posts
--   bulk_ai_jobs
--   bulk_import_jobs
--   bundles
--   campaign_recipients
--   campaigns
--   carts
--   categories
--   count_sessions
--   coupons
--   customer_cohort_snapshots
--   customer_groups
--   customer_rfm_snapshots
--   customer_wallets
--   customers
--   deadstock_flags
--   expenses
--   frequently_bought_together
--   funnel_snapshots
--   fx_rate_entries
--   gsc_daily_metrics
--   inventory_history
--   journal_entries
--   loyalty_points
--   loyalty_transactions
--   merchant_api_keys
--   newsletter_subscribers
--   notification_configs
--   notification_event_configs
--   notification_logs
--   order_events
--   orders
--   payment_configs  [store_id NULLABLE: NULL rows are unreachable for ebda_app]
--   payment_events
--   product_daily_views
--   product_relations
--   products
--   profit_anomalies
--   promotions
--   purchase_orders
--   push_subscriptions
--   reorder_rules
--   reorder_suggestions
--   returns
--   reviews
--   sequences
--   shipments
--   shipping_area_rates
--   shipping_carrier_configs
--   shipping_zones
--   sms_marketing_consents
--   stock_adjustments
--   store_faqs
--   store_features
--   store_howtos
--   store_locations
--   store_pages
--   store_subscriptions   (SP5 plans engine, migration 20261003130000)
--   store_usage_snapshots
--   suppliers
--   tags  [store_id NULLABLE: NULL rows are unreachable for ebda_app]
--   tax_rates
--   wallet_transactions
--   warehouse_stock
--   warehouses
--   webhook_events  [store_id NULLABLE: NULL rows are unreachable for ebda_app]
--   whatsapp_templates
--   wishlists
--   store_staff   [own memberships also match user_id = app.current_user_id]
--   users         [store_id NULLABLE: admin-namespace accounts have store_id NULL; see below]
--
-- TABLES KEYED BY A camelCase COLUMN
--   "SlugRedirect" ("storeId")
--
-- TABLES WITHOUT store_id THAT HOLD TENANT DATA (policy: EXISTS parent in the store)
--   bundle_items               via bundles (bundle_id)
--   cart_bundles               via carts (cart_id)
--   cart_items                 via carts (cart_id)
--   count_lines                via count_sessions (session_id)
--   customer_addresses         via customers (customer_id)
--   journal_lines              via journal_entries (entry_id)
--   order_items                via orders (order_id)
--   payments                   via orders (order_id)
--   product_categories         via products (product_id)
--   product_faqs               via products (product_id)
--   product_images             via products (product_id)
--   product_options            via products (product_id)
--   product_tags               via products (product_id)
--   product_variants           via products (product_id)
--   purchase_order_items       via purchase_orders (po_id)
--   return_items               via returns (return_id)
--   stock_adjustment_items     via stock_adjustments (adjustment_id)
--   wishlist_items             via wishlists (wishlist_id)
--   product_option_values      via product_options -> products (option_id)
--   product_variant_options    via product_variants -> products (variant_id)
--
-- IDENTITY TABLES (keyed by user, not store)
--   users      visible when store_id = store GUC, OR id = app.current_user_id,
--              OR the user owns / is staff of the GUC store, OR the acting user
--              (app.current_user_id) is an ACTIVE super_admin (looked up by data
--              through ebda_is_super_admin(), see 2b). Admin accounts are
--              otherwise unreachable; login, token checks and invites go through
--              the ebda_* definer functions below.
--   addresses  user_id = app.current_user_id.
--   store_staff  store_id = store GUC OR user_id = app.current_user_id (a staff
--              member lists their own memberships).
--
-- DELIBERATELY NOT UNDER RLS (documented exceptions)
--   stores                  tenant root and routing table (host -> store). It
--                           has no store_id column; its secret columns
--                           (wbs_api_key, meta_access_token, agent_api_key) are
--                           omitted by the Prisma client by default. Making it
--                           deny-all would force a definer function on ~60
--                           read sites for no tenant-data gain. Revisit in SP5.
--   refresh_tokens, verification_tokens, onesignal_subscriptions
--                           keyed by user_id and looked up by an unguessable
--                           token hash BEFORE the user is known; the token is
--                           the credential. A user-scoped policy would need a
--                           definer for every auth path. Revisit in SP5.
--   answer_engine_provider_configs
--                           platform-global provider credentials, no tenant.
--   plans                   platform-global plan catalog (SP5; config written only
--                           by super_admin routes, no tenant data, no store_id).
--   system_settings         platform-global key/value; policy is `true` for
--                           ebda_app (it holds no tenant data).
--   _prisma_migrations      not granted to ebda_app at all.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 0. The owner must bypass RLS itself (see header).
-- ---------------------------------------------------------------------------
DO $owner$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)
  ) THEN
    RAISE EXCEPTION
      'strict-RLS migration must run as a role that bypasses RLS (superuser or BYPASSRLS): % does not',
      current_user;
  END IF;
END
$owner$;

-- ---------------------------------------------------------------------------
-- 1. The runtime role. NOLOGIN here; ops grants LOGIN + password per environment
--    (ALTER ROLE ebda_app LOGIN PASSWORD '...'). Existing LOGIN is left as is.
-- ---------------------------------------------------------------------------
DO $role$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'ebda_app') THEN
    CREATE ROLE ebda_app NOLOGIN;
  END IF;
  ALTER ROLE ebda_app NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
END
$role$;

-- ---------------------------------------------------------------------------
-- 2. Grants: DML on application tables and sequences. No TRUNCATE, no DDL, no
--    migration bookkeeping. Future tables inherit the DML grants.
-- ---------------------------------------------------------------------------
GRANT USAGE ON SCHEMA public TO ebda_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ebda_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ebda_app;
REVOKE ALL ON TABLE public._prisma_migrations FROM ebda_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ebda_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ebda_app;

-- ---------------------------------------------------------------------------
-- 2b. Platform operators. `users` is the one table where a super_admin principal
--     (the user in app.current_user_id, looked up by DATA: role = 'super_admin',
--     active, not deleted) may read and write every row: the platform's user
--     directory, owner joins on store lists, role changes. It is NOT a bypass
--     flag a request can set on its own and it opens no other table; an unset
--     user GUC matches nothing. A definer function reads the role so the policy
--     does not recurse into `users`.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ebda_is_super_admin()
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
  SELECT EXISTS (
    SELECT 1 FROM public.users u
    WHERE u.id = nullif(current_setting('app.current_user_id', true), '')
      AND u.role = 'super_admin' AND u.status = 'active' AND u.deleted_at IS NULL
  )
$fn$;

-- ---------------------------------------------------------------------------
-- 2c. Caller checks for the MUTATING and cross-store definers in section 5.
--     A SECURITY DEFINER function runs as the owner and sees every row, so a
--     function that accepts "any id" would let one application bug (or an
--     injected statement) rewrite another tenant's data despite RLS. Each
--     mutating function therefore checks WHO is calling, from the same
--     transaction-local settings the policies use, and raises SQLSTATE 42501
--     (insufficient_privilege) when the caller has no business with the target.
--
--     ebda_may_act_on_user(p_user_id): the caller IS that user
--       (app.current_user_id), OR is an ACTIVE super_admin, OR the user belongs
--       to the store the transaction is scoped to: a customer
--       (users.store_id = app.current_store_id) or a staff member / the owner of
--       that store (store_staff / stores.owner_id). It never matches when no
--       user and no store is set.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ebda_may_act_on_user(p_user_id text)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
  SELECT p_user_id IS NOT NULL AND (
    coalesce(p_user_id = nullif(current_setting('app.current_user_id', true), ''), false)
    OR public.ebda_is_super_admin()
    OR EXISTS (
      SELECT 1 FROM public.users u
      WHERE u.id = p_user_id AND u.store_id IS NOT NULL
        AND u.store_id = nullif(current_setting('app.current_store_id', true), '')
    )
    OR EXISTS (
      SELECT 1 FROM public.store_staff ss
      WHERE ss.user_id = p_user_id
        AND ss.store_id = nullif(current_setting('app.current_store_id', true), '')
    )
    OR EXISTS (
      SELECT 1 FROM public.stores s
      WHERE s.owner_id = p_user_id
        AND s.id = nullif(current_setting('app.current_store_id', true), '')
    )
  )
$fn$;

--     ebda_is_system_job(p_job): the transaction was opened by the named platform
--       job (`withSystemJob` in @force/database sets app.system_job
--       transaction-locally). Used ONLY for the few cross-store definers that run
--       from a cron with no store and no user (audit retention, the webhook
--       inbox consumer). It is a named, narrow context, not a bypass: it opens
--       no table to ebda_app and no other function checks it.
CREATE OR REPLACE FUNCTION public.ebda_is_system_job(p_job text)
RETURNS boolean
LANGUAGE sql STABLE
SET search_path = pg_catalog, public, pg_temp
AS $fn$
  SELECT coalesce(nullif(current_setting('app.system_job', true), ''), '') = p_job
$fn$;

-- ---------------------------------------------------------------------------
-- 3. Drop EVERY existing policy on the covered tables. FWB's policies mixed four
--    generations (hybrid allow-contextless, strict, bypass-GUC, role-less
--    PUBLIC); none is kept, so nothing can re-open a contextless allowance or
--    the app.bypass_rls path. The rows below replace them one-for-one.
-- ---------------------------------------------------------------------------
DO $drop$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT schemaname, tablename, policyname
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = ANY (ARRAY[
        'abandoned_cart_configs',
        'abandoned_carts',
        'accounts',
        'affiliate_configs',
        'affiliate_events',
        'affiliate_payouts',
        'affiliate_referrals',
        'affiliates',
        'ai_recommendation',
        'ai_usage',
        'answer_engine_checks',
        'audit_logs',
        'backorder_lines',
        'bank_statements',
        'bank_transactions',
        'blog_posts',
        'bulk_ai_jobs',
        'bulk_import_jobs',
        'bundles',
        'campaign_recipients',
        'campaigns',
        'carts',
        'categories',
        'count_sessions',
        'coupons',
        'customer_cohort_snapshots',
        'customer_groups',
        'customer_rfm_snapshots',
        'customer_wallets',
        'customers',
        'deadstock_flags',
        'expenses',
        'frequently_bought_together',
        'funnel_snapshots',
        'fx_rate_entries',
        'gsc_daily_metrics',
        'inventory_history',
        'journal_entries',
        'loyalty_points',
        'loyalty_transactions',
        'merchant_api_keys',
        'newsletter_subscribers',
        'notification_configs',
        'notification_event_configs',
        'notification_logs',
        'order_events',
        'orders',
        'payment_configs',
        'payment_events',
        'product_daily_views',
        'product_relations',
        'products',
        'profit_anomalies',
        'promotions',
        'purchase_orders',
        'push_subscriptions',
        'reorder_rules',
        'reorder_suggestions',
        'returns',
        'reviews',
        'sequences',
        'shipments',
        'shipping_area_rates',
        'shipping_carrier_configs',
        'shipping_zones',
        'sms_marketing_consents',
        'stock_adjustments',
        'store_faqs',
        'store_features',
        'store_howtos',
        'store_locations',
        'store_pages',
        'store_subscriptions',
        'store_usage_snapshots',
        'suppliers',
        'tags',
        'tax_rates',
        'wallet_transactions',
        'warehouse_stock',
        'warehouses',
        'webhook_events',
        'whatsapp_templates',
        'wishlists',
        'users',
        'store_staff',
        'SlugRedirect',
        'addresses',
        'system_settings',
        'bundle_items',
        'cart_bundles',
        'cart_items',
        'count_lines',
        'customer_addresses',
        'journal_lines',
        'order_items',
        'payments',
        'product_categories',
        'product_faqs',
        'product_images',
        'product_options',
        'product_tags',
        'product_variants',
        'purchase_order_items',
        'return_items',
        'stock_adjustment_items',
        'wishlist_items',
        'product_option_values',
        'product_variant_options'
      ])
  LOOP
    EXECUTE format('DROP POLICY %I ON %I.%I', r.policyname, r.schemaname, r.tablename);
  END LOOP;
END
$drop$;

-- ---------------------------------------------------------------------------
-- 4. ENABLE + FORCE RLS and one strict policy per table.
-- ---------------------------------------------------------------------------

-- 4a. Tables with a store_id column: store_id = the transaction-local store.
ALTER TABLE abandoned_cart_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE abandoned_cart_configs FORCE ROW LEVEL SECURITY;
CREATE POLICY ebda_tenant_isolation ON abandoned_cart_configs AS PERMISSIVE FOR ALL TO ebda_app
  USING (store_id = nullif(current_setting('app.current_store_id', true), ''))
  WITH CHECK (store_id = nullif(current_setting('app.current_store_id', true), ''));
ALTER TABLE abandoned_carts ENABLE ROW LEVEL SECURITY;
ALTER TABLE abandoned_carts FORCE ROW LEVEL SECURITY;
CREATE POLICY ebda_tenant_isolation ON abandoned_carts AS PERMISSIVE FOR ALL TO ebda_app
  USING (store_id = nullif(current_setting('app.current_store_id', true), ''))
  WITH CHECK (store_id = nullif(current_setting('app.current_store_id', true), ''));
ALTER TABLE accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE accounts FORCE ROW LEVEL SECURITY;
CREATE POLICY ebda_tenant_isolation ON accounts AS PERMISSIVE FOR ALL TO ebda_app
  USING (store_id = nullif(current_setting('app.current_store_id', true), ''))
  WITH CHECK (store_id = nullif(current_setting('app.current_store_id', true), ''));
ALTER TABLE affiliate_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE affiliate_configs FORCE ROW LEVEL SECURITY;
CREATE POLICY ebda_tenant_isolation ON affiliate_configs AS PERMISSIVE FOR ALL TO ebda_app
  USING (store_id = nullif(current_setting('app.current_store_id', true), ''))
  WITH CHECK (store_id = nullif(current_setting('app.current_store_id', true), ''));
ALTER TABLE affiliate_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE affiliate_events FORCE ROW LEVEL SECURITY;
CREATE POLICY ebda_tenant_isolation ON affiliate_events AS PERMISSIVE FOR ALL TO ebda_app
  USING (store_id = nullif(current_setting('app.current_store_id', true), ''))
  WITH CHECK (store_id = nullif(current_setting('app.current_store_id', true), ''));
ALTER TABLE affiliate_payouts ENABLE ROW LEVEL SECURITY;
ALTER TABLE affiliate_payouts FORCE ROW LEVEL SECURITY;
CREATE POLICY ebda_tenant_isolation ON affiliate_payouts AS PERMISSIVE FOR ALL TO ebda_app
  USING (store_id = nullif(current_setting('app.current_store_id', true), ''))
  WITH CHECK (store_id = nullif(current_setting('app.current_store_id', true), ''));
ALTER TABLE affiliate_referrals ENABLE ROW LEVEL SECURITY;
ALTER TABLE affiliate_referrals FORCE ROW LEVEL SECURITY;
CREATE POLICY ebda_tenant_isolation ON affiliate_referrals AS PERMISSIVE FOR ALL TO ebda_app
  USING (store_id = nullif(current_setting('app.current_store_id', true), ''))
  WITH CHECK (store_id = nullif(current_setting('app.current_store_id', true), ''));
ALTER TABLE affiliates ENABLE ROW LEVEL SECURITY;
ALTER TABLE affiliates FORCE ROW LEVEL SECURITY;
CREATE POLICY ebda_tenant_isolation ON affiliates AS PERMISSIVE FOR ALL TO ebda_app
  USING (store_id = nullif(current_setting('app.current_store_id', true), ''))
  WITH CHECK (store_id = nullif(current_setting('app.current_store_id', true), ''));
ALTER TABLE ai_recommendation ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_recommendation FORCE ROW LEVEL SECURITY;
CREATE POLICY ebda_tenant_isolation ON ai_recommendation AS PERMISSIVE FOR ALL TO ebda_app
  USING (store_id = nullif(current_setting('app.current_store_id', true), ''))
  WITH CHECK (store_id = nullif(current_setting('app.current_store_id', true), ''));
ALTER TABLE ai_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_usage FORCE ROW LEVEL SECURITY;
CREATE POLICY ebda_tenant_isolation ON ai_usage AS PERMISSIVE FOR ALL TO ebda_app
  USING (store_id = nullif(current_setting('app.current_store_id', true), ''))
  WITH CHECK (store_id = nullif(current_setting('app.current_store_id', true), ''));
ALTER TABLE answer_engine_checks ENABLE ROW LEVEL SECURITY;
ALTER TABLE answer_engine_checks FORCE ROW LEVEL SECURITY;
CREATE POLICY ebda_tenant_isolation ON answer_engine_checks AS PERMISSIVE FOR ALL TO ebda_app
  USING (store_id = nullif(current_setting('app.current_store_id', true), ''))
  WITH CHECK (store_id = nullif(current_setting('app.current_store_id', true), ''));
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs FORCE ROW LEVEL SECURITY;
CREATE POLICY ebda_tenant_isolation ON audit_logs AS PERMISSIVE FOR ALL TO ebda_app
  USING (store_id = nullif(current_setting('app.current_store_id', true), ''))
  WITH CHECK (store_id = nullif(current_setting('app.current_store_id', true), ''));
ALTER TABLE backorder_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE backorder_lines FORCE ROW LEVEL SECURITY;
CREATE POLICY ebda_tenant_isolation ON backorder_lines AS PERMISSIVE FOR ALL TO ebda_app
  USING (store_id = nullif(current_setting('app.current_store_id', true), ''))
  WITH CHECK (store_id = nullif(current_setting('app.current_store_id', true), ''));
ALTER TABLE bank_statements ENABLE ROW LEVEL SECURITY;
ALTER TABLE bank_statements FORCE ROW LEVEL SECURITY;
CREATE POLICY ebda_tenant_isolation ON bank_statements AS PERMISSIVE FOR ALL TO ebda_app
  USING (store_id = nullif(current_setting('app.current_store_id', true), ''))
  WITH CHECK (store_id = nullif(current_setting('app.current_store_id', true), ''));
ALTER TABLE bank_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE bank_transactions FORCE ROW LEVEL SECURITY;
CREATE POLICY ebda_tenant_isolation ON bank_transactions AS PERMISSIVE FOR ALL TO ebda_app
  USING (store_id = nullif(current_setting('app.current_store_id', true), ''))
  WITH CHECK (store_id = nullif(current_setting('app.current_store_id', true), ''));
ALTER TABLE blog_posts ENABLE ROW LEVEL SECURITY;
ALTER TABLE blog_posts FORCE ROW LEVEL SECURITY;
CREATE POLICY ebda_tenant_isolation ON blog_posts AS PERMISSIVE FOR ALL TO ebda_app
  USING (store_id = nullif(current_setting('app.current_store_id', true), ''))
  WITH CHECK (store_id = nullif(current_setting('app.current_store_id', true), ''));
ALTER TABLE bulk_ai_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE bulk_ai_jobs FORCE ROW LEVEL SECURITY;
CREATE POLICY ebda_tenant_isolation ON bulk_ai_jobs AS PERMISSIVE FOR ALL TO ebda_app
  USING (store_id = nullif(current_setting('app.current_store_id', true), ''))
  WITH CHECK (store_id = nullif(current_setting('app.current_store_id', true), ''));
ALTER TABLE bulk_import_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE bulk_import_jobs FORCE ROW LEVEL SECURITY;
CREATE POLICY ebda_tenant_isolation ON bulk_import_jobs AS PERMISSIVE FOR ALL TO ebda_app
  USING (store_id = nullif(current_setting('app.current_store_id', true), ''))
  WITH CHECK (store_id = nullif(current_setting('app.current_store_id', true), ''));
ALTER TABLE bundles ENABLE ROW LEVEL SECURITY;
ALTER TABLE bundles FORCE ROW LEVEL SECURITY;
CREATE POLICY ebda_tenant_isolation ON bundles AS PERMISSIVE FOR ALL TO ebda_app
  USING (store_id = nullif(current_setting('app.current_store_id', true), ''))
  WITH CHECK (store_id = nullif(current_setting('app.current_store_id', true), ''));
ALTER TABLE campaign_recipients ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_recipients FORCE ROW LEVEL SECURITY;
CREATE POLICY ebda_tenant_isolation ON campaign_recipients AS PERMISSIVE FOR ALL TO ebda_app
  USING (store_id = nullif(current_setting('app.current_store_id', true), ''))
  WITH CHECK (store_id = nullif(current_setting('app.current_store_id', true), ''));
ALTER TABLE campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaigns FORCE ROW LEVEL SECURITY;
CREATE POLICY ebda_tenant_isolation ON campaigns AS PERMISSIVE FOR ALL TO ebda_app
  USING (store_id = nullif(current_setting('app.current_store_id', true), ''))
  WITH CHECK (store_id = nullif(current_setting('app.current_store_id', true), ''));
ALTER TABLE carts ENABLE ROW LEVEL SECURITY;
ALTER TABLE carts FORCE ROW LEVEL SECURITY;
CREATE POLICY ebda_tenant_isolation ON carts AS PERMISSIVE FOR ALL TO ebda_app
  USING (store_id = nullif(current_setting('app.current_store_id', true), ''))
  WITH CHECK (store_id = nullif(current_setting('app.current_store_id', true), ''));
ALTER TABLE categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE categories FORCE ROW LEVEL SECURITY;
CREATE POLICY ebda_tenant_isolation ON categories AS PERMISSIVE FOR ALL TO ebda_app
  USING (store_id = nullif(current_setting('app.current_store_id', true), ''))
  WITH CHECK (store_id = nullif(current_setting('app.current_store_id', true), ''));
ALTER TABLE count_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE count_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY ebda_tenant_isolation ON count_sessions AS PERMISSIVE FOR ALL TO ebda_app
  USING (store_id = nullif(current_setting('app.current_store_id', true), ''))
  WITH CHECK (store_id = nullif(current_setting('app.current_store_id', true), ''));
ALTER TABLE coupons ENABLE ROW LEVEL SECURITY;
ALTER TABLE coupons FORCE ROW LEVEL SECURITY;
CREATE POLICY ebda_tenant_isolation ON coupons AS PERMISSIVE FOR ALL TO ebda_app
  USING (store_id = nullif(current_setting('app.current_store_id', true), ''))
  WITH CHECK (store_id = nullif(current_setting('app.current_store_id', true), ''));
ALTER TABLE customer_cohort_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_cohort_snapshots FORCE ROW LEVEL SECURITY;
CREATE POLICY ebda_tenant_isolation ON customer_cohort_snapshots AS PERMISSIVE FOR ALL TO ebda_app
  USING (store_id = nullif(current_setting('app.current_store_id', true), ''))
  WITH CHECK (store_id = nullif(current_setting('app.current_store_id', true), ''));
ALTER TABLE customer_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_groups FORCE ROW LEVEL SECURITY;
CREATE POLICY ebda_tenant_isolation ON customer_groups AS PERMISSIVE FOR ALL TO ebda_app
  USING (store_id = nullif(current_setting('app.current_store_id', true), ''))
  WITH CHECK (store_id = nullif(current_setting('app.current_store_id', true), ''));
ALTER TABLE customer_rfm_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_rfm_snapshots FORCE ROW LEVEL SECURITY;
CREATE POLICY ebda_tenant_isolation ON customer_rfm_snapshots AS PERMISSIVE FOR ALL TO ebda_app
  USING (store_id = nullif(current_setting('app.current_store_id', true), ''))
  WITH CHECK (store_id = nullif(current_setting('app.current_store_id', true), ''));
ALTER TABLE customer_wallets ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_wallets FORCE ROW LEVEL SECURITY;
CREATE POLICY ebda_tenant_isolation ON customer_wallets AS PERMISSIVE FOR ALL TO ebda_app
  USING (store_id = nullif(current_setting('app.current_store_id', true), ''))
  WITH CHECK (store_id = nullif(current_setting('app.current_store_id', true), ''));
ALTER TABLE customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE customers FORCE ROW LEVEL SECURITY;
CREATE POLICY ebda_tenant_isolation ON customers AS PERMISSIVE FOR ALL TO ebda_app
  USING (store_id = nullif(current_setting('app.current_store_id', true), ''))
  WITH CHECK (store_id = nullif(current_setting('app.current_store_id', true), ''));
ALTER TABLE deadstock_flags ENABLE ROW LEVEL SECURITY;
ALTER TABLE deadstock_flags FORCE ROW LEVEL SECURITY;
CREATE POLICY ebda_tenant_isolation ON deadstock_flags AS PERMISSIVE FOR ALL TO ebda_app
  USING (store_id = nullif(current_setting('app.current_store_id', true), ''))
  WITH CHECK (store_id = nullif(current_setting('app.current_store_id', true), ''));
ALTER TABLE expenses ENABLE ROW LEVEL SECURITY;
ALTER TABLE expenses FORCE ROW LEVEL SECURITY;
CREATE POLICY ebda_tenant_isolation ON expenses AS PERMISSIVE FOR ALL TO ebda_app
  USING (store_id = nullif(current_setting('app.current_store_id', true), ''))
  WITH CHECK (store_id = nullif(current_setting('app.current_store_id', true), ''));
ALTER TABLE frequently_bought_together ENABLE ROW LEVEL SECURITY;
ALTER TABLE frequently_bought_together FORCE ROW LEVEL SECURITY;
CREATE POLICY ebda_tenant_isolation ON frequently_bought_together AS PERMISSIVE FOR ALL TO ebda_app
  USING (store_id = nullif(current_setting('app.current_store_id', true), ''))
  WITH CHECK (store_id = nullif(current_setting('app.current_store_id', true), ''));
ALTER TABLE funnel_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE funnel_snapshots FORCE ROW LEVEL SECURITY;
CREATE POLICY ebda_tenant_isolation ON funnel_snapshots AS PERMISSIVE FOR ALL TO ebda_app
  USING (store_id = nullif(current_setting('app.current_store_id', true), ''))
  WITH CHECK (store_id = nullif(current_setting('app.current_store_id', true), ''));
ALTER TABLE fx_rate_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE fx_rate_entries FORCE ROW LEVEL SECURITY;
CREATE POLICY ebda_tenant_isolation ON fx_rate_entries AS PERMISSIVE FOR ALL TO ebda_app
  USING (store_id = nullif(current_setting('app.current_store_id', true), ''))
  WITH CHECK (store_id = nullif(current_setting('app.current_store_id', true), ''));
ALTER TABLE gsc_daily_metrics ENABLE ROW LEVEL SECURITY;
ALTER TABLE gsc_daily_metrics FORCE ROW LEVEL SECURITY;
CREATE POLICY ebda_tenant_isolation ON gsc_daily_metrics AS PERMISSIVE FOR ALL TO ebda_app
  USING (store_id = nullif(current_setting('app.current_store_id', true), ''))
  WITH CHECK (store_id = nullif(current_setting('app.current_store_id', true), ''));
ALTER TABLE inventory_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_history FORCE ROW LEVEL SECURITY;
CREATE POLICY ebda_tenant_isolation ON inventory_history AS PERMISSIVE FOR ALL TO ebda_app
  USING (store_id = nullif(current_setting('app.current_store_id', true), ''))
  WITH CHECK (store_id = nullif(current_setting('app.current_store_id', true), ''));
ALTER TABLE journal_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE journal_entries FORCE ROW LEVEL SECURITY;
CREATE POLICY ebda_tenant_isolation ON journal_entries AS PERMISSIVE FOR ALL TO ebda_app
  USING (store_id = nullif(current_setting('app.current_store_id', true), ''))
  WITH CHECK (store_id = nullif(current_setting('app.current_store_id', true), ''));
ALTER TABLE loyalty_points ENABLE ROW LEVEL SECURITY;
ALTER TABLE loyalty_points FORCE ROW LEVEL SECURITY;
CREATE POLICY ebda_tenant_isolation ON loyalty_points AS PERMISSIVE FOR ALL TO ebda_app
  USING (store_id = nullif(current_setting('app.current_store_id', true), ''))
  WITH CHECK (store_id = nullif(current_setting('app.current_store_id', true), ''));
ALTER TABLE loyalty_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE loyalty_transactions FORCE ROW LEVEL SECURITY;
CREATE POLICY ebda_tenant_isolation ON loyalty_transactions AS PERMISSIVE FOR ALL TO ebda_app
  USING (store_id = nullif(current_setting('app.current_store_id', true), ''))
  WITH CHECK (store_id = nullif(current_setting('app.current_store_id', true), ''));
ALTER TABLE merchant_api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE merchant_api_keys FORCE ROW LEVEL SECURITY;
CREATE POLICY ebda_tenant_isolation ON merchant_api_keys AS PERMISSIVE FOR ALL TO ebda_app
  USING (store_id = nullif(current_setting('app.current_store_id', true), ''))
  WITH CHECK (store_id = nullif(current_setting('app.current_store_id', true), ''));
ALTER TABLE newsletter_subscribers ENABLE ROW LEVEL SECURITY;
ALTER TABLE newsletter_subscribers FORCE ROW LEVEL SECURITY;
CREATE POLICY ebda_tenant_isolation ON newsletter_subscribers AS PERMISSIVE FOR ALL TO ebda_app
  USING (store_id = nullif(current_setting('app.current_store_id', true), ''))
  WITH CHECK (store_id = nullif(current_setting('app.current_store_id', true), ''));
ALTER TABLE notification_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_configs FORCE ROW LEVEL SECURITY;
CREATE POLICY ebda_tenant_isolation ON notification_configs AS PERMISSIVE FOR ALL TO ebda_app
  USING (store_id = nullif(current_setting('app.current_store_id', true), ''))
  WITH CHECK (store_id = nullif(current_setting('app.current_store_id', true), ''));
ALTER TABLE notification_event_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_event_configs FORCE ROW LEVEL SECURITY;
CREATE POLICY ebda_tenant_isolation ON notification_event_configs AS PERMISSIVE FOR ALL TO ebda_app
  USING (store_id = nullif(current_setting('app.current_store_id', true), ''))
  WITH CHECK (store_id = nullif(current_setting('app.current_store_id', true), ''));
ALTER TABLE notification_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_logs FORCE ROW LEVEL SECURITY;
CREATE POLICY ebda_tenant_isolation ON notification_logs AS PERMISSIVE FOR ALL TO ebda_app
  USING (store_id = nullif(current_setting('app.current_store_id', true), ''))
  WITH CHECK (store_id = nullif(current_setting('app.current_store_id', true), ''));
ALTER TABLE order_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_events FORCE ROW LEVEL SECURITY;
CREATE POLICY ebda_tenant_isolation ON order_events AS PERMISSIVE FOR ALL TO ebda_app
  USING (store_id = nullif(current_setting('app.current_store_id', true), ''))
  WITH CHECK (store_id = nullif(current_setting('app.current_store_id', true), ''));
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders FORCE ROW LEVEL SECURITY;
CREATE POLICY ebda_tenant_isolation ON orders AS PERMISSIVE FOR ALL TO ebda_app
  USING (store_id = nullif(current_setting('app.current_store_id', true), ''))
  WITH CHECK (store_id = nullif(current_setting('app.current_store_id', true), ''));
ALTER TABLE payment_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_configs FORCE ROW LEVEL SECURITY;
CREATE POLICY ebda_tenant_isolation ON payment_configs AS PERMISSIVE FOR ALL TO ebda_app
  USING (store_id = nullif(current_setting('app.current_store_id', true), ''))
  WITH CHECK (store_id = nullif(current_setting('app.current_store_id', true), ''));
ALTER TABLE payment_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_events FORCE ROW LEVEL SECURITY;
CREATE POLICY ebda_tenant_isolation ON payment_events AS PERMISSIVE FOR ALL TO ebda_app
  USING (store_id = nullif(current_setting('app.current_store_id', true), ''))
  WITH CHECK (store_id = nullif(current_setting('app.current_store_id', true), ''));
ALTER TABLE product_daily_views ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_daily_views FORCE ROW LEVEL SECURITY;
CREATE POLICY ebda_tenant_isolation ON product_daily_views AS PERMISSIVE FOR ALL TO ebda_app
  USING (store_id = nullif(current_setting('app.current_store_id', true), ''))
  WITH CHECK (store_id = nullif(current_setting('app.current_store_id', true), ''));
ALTER TABLE product_relations ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_relations FORCE ROW LEVEL SECURITY;
CREATE POLICY ebda_tenant_isolation ON product_relations AS PERMISSIVE FOR ALL TO ebda_app
  USING (store_id = nullif(current_setting('app.current_store_id', true), ''))
  WITH CHECK (store_id = nullif(current_setting('app.current_store_id', true), ''));
ALTER TABLE products ENABLE ROW LEVEL SECURITY;
ALTER TABLE products FORCE ROW LEVEL SECURITY;
CREATE POLICY ebda_tenant_isolation ON products AS PERMISSIVE FOR ALL TO ebda_app
  USING (store_id = nullif(current_setting('app.current_store_id', true), ''))
  WITH CHECK (store_id = nullif(current_setting('app.current_store_id', true), ''));
ALTER TABLE profit_anomalies ENABLE ROW LEVEL SECURITY;
ALTER TABLE profit_anomalies FORCE ROW LEVEL SECURITY;
CREATE POLICY ebda_tenant_isolation ON profit_anomalies AS PERMISSIVE FOR ALL TO ebda_app
  USING (store_id = nullif(current_setting('app.current_store_id', true), ''))
  WITH CHECK (store_id = nullif(current_setting('app.current_store_id', true), ''));
ALTER TABLE promotions ENABLE ROW LEVEL SECURITY;
ALTER TABLE promotions FORCE ROW LEVEL SECURITY;
CREATE POLICY ebda_tenant_isolation ON promotions AS PERMISSIVE FOR ALL TO ebda_app
  USING (store_id = nullif(current_setting('app.current_store_id', true), ''))
  WITH CHECK (store_id = nullif(current_setting('app.current_store_id', true), ''));
ALTER TABLE purchase_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchase_orders FORCE ROW LEVEL SECURITY;
CREATE POLICY ebda_tenant_isolation ON purchase_orders AS PERMISSIVE FOR ALL TO ebda_app
  USING (store_id = nullif(current_setting('app.current_store_id', true), ''))
  WITH CHECK (store_id = nullif(current_setting('app.current_store_id', true), ''));
ALTER TABLE push_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE push_subscriptions FORCE ROW LEVEL SECURITY;
CREATE POLICY ebda_tenant_isolation ON push_subscriptions AS PERMISSIVE FOR ALL TO ebda_app
  USING (store_id = nullif(current_setting('app.current_store_id', true), ''))
  WITH CHECK (store_id = nullif(current_setting('app.current_store_id', true), ''));
ALTER TABLE reorder_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE reorder_rules FORCE ROW LEVEL SECURITY;
CREATE POLICY ebda_tenant_isolation ON reorder_rules AS PERMISSIVE FOR ALL TO ebda_app
  USING (store_id = nullif(current_setting('app.current_store_id', true), ''))
  WITH CHECK (store_id = nullif(current_setting('app.current_store_id', true), ''));
ALTER TABLE reorder_suggestions ENABLE ROW LEVEL SECURITY;
ALTER TABLE reorder_suggestions FORCE ROW LEVEL SECURITY;
CREATE POLICY ebda_tenant_isolation ON reorder_suggestions AS PERMISSIVE FOR ALL TO ebda_app
  USING (store_id = nullif(current_setting('app.current_store_id', true), ''))
  WITH CHECK (store_id = nullif(current_setting('app.current_store_id', true), ''));
ALTER TABLE returns ENABLE ROW LEVEL SECURITY;
ALTER TABLE returns FORCE ROW LEVEL SECURITY;
CREATE POLICY ebda_tenant_isolation ON returns AS PERMISSIVE FOR ALL TO ebda_app
  USING (store_id = nullif(current_setting('app.current_store_id', true), ''))
  WITH CHECK (store_id = nullif(current_setting('app.current_store_id', true), ''));
ALTER TABLE reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE reviews FORCE ROW LEVEL SECURITY;
CREATE POLICY ebda_tenant_isolation ON reviews AS PERMISSIVE FOR ALL TO ebda_app
  USING (store_id = nullif(current_setting('app.current_store_id', true), ''))
  WITH CHECK (store_id = nullif(current_setting('app.current_store_id', true), ''));
ALTER TABLE sequences ENABLE ROW LEVEL SECURITY;
ALTER TABLE sequences FORCE ROW LEVEL SECURITY;
CREATE POLICY ebda_tenant_isolation ON sequences AS PERMISSIVE FOR ALL TO ebda_app
  USING (store_id = nullif(current_setting('app.current_store_id', true), ''))
  WITH CHECK (store_id = nullif(current_setting('app.current_store_id', true), ''));
ALTER TABLE shipments ENABLE ROW LEVEL SECURITY;
ALTER TABLE shipments FORCE ROW LEVEL SECURITY;
CREATE POLICY ebda_tenant_isolation ON shipments AS PERMISSIVE FOR ALL TO ebda_app
  USING (store_id = nullif(current_setting('app.current_store_id', true), ''))
  WITH CHECK (store_id = nullif(current_setting('app.current_store_id', true), ''));
ALTER TABLE shipping_area_rates ENABLE ROW LEVEL SECURITY;
ALTER TABLE shipping_area_rates FORCE ROW LEVEL SECURITY;
CREATE POLICY ebda_tenant_isolation ON shipping_area_rates AS PERMISSIVE FOR ALL TO ebda_app
  USING (store_id = nullif(current_setting('app.current_store_id', true), ''))
  WITH CHECK (store_id = nullif(current_setting('app.current_store_id', true), ''));
ALTER TABLE shipping_carrier_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE shipping_carrier_configs FORCE ROW LEVEL SECURITY;
CREATE POLICY ebda_tenant_isolation ON shipping_carrier_configs AS PERMISSIVE FOR ALL TO ebda_app
  USING (store_id = nullif(current_setting('app.current_store_id', true), ''))
  WITH CHECK (store_id = nullif(current_setting('app.current_store_id', true), ''));
ALTER TABLE shipping_zones ENABLE ROW LEVEL SECURITY;
ALTER TABLE shipping_zones FORCE ROW LEVEL SECURITY;
CREATE POLICY ebda_tenant_isolation ON shipping_zones AS PERMISSIVE FOR ALL TO ebda_app
  USING (store_id = nullif(current_setting('app.current_store_id', true), ''))
  WITH CHECK (store_id = nullif(current_setting('app.current_store_id', true), ''));
ALTER TABLE sms_marketing_consents ENABLE ROW LEVEL SECURITY;
ALTER TABLE sms_marketing_consents FORCE ROW LEVEL SECURITY;
CREATE POLICY ebda_tenant_isolation ON sms_marketing_consents AS PERMISSIVE FOR ALL TO ebda_app
  USING (store_id = nullif(current_setting('app.current_store_id', true), ''))
  WITH CHECK (store_id = nullif(current_setting('app.current_store_id', true), ''));
ALTER TABLE stock_adjustments ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_adjustments FORCE ROW LEVEL SECURITY;
CREATE POLICY ebda_tenant_isolation ON stock_adjustments AS PERMISSIVE FOR ALL TO ebda_app
  USING (store_id = nullif(current_setting('app.current_store_id', true), ''))
  WITH CHECK (store_id = nullif(current_setting('app.current_store_id', true), ''));
ALTER TABLE store_faqs ENABLE ROW LEVEL SECURITY;
ALTER TABLE store_faqs FORCE ROW LEVEL SECURITY;
CREATE POLICY ebda_tenant_isolation ON store_faqs AS PERMISSIVE FOR ALL TO ebda_app
  USING (store_id = nullif(current_setting('app.current_store_id', true), ''))
  WITH CHECK (store_id = nullif(current_setting('app.current_store_id', true), ''));
ALTER TABLE store_features ENABLE ROW LEVEL SECURITY;
ALTER TABLE store_features FORCE ROW LEVEL SECURITY;
CREATE POLICY ebda_tenant_isolation ON store_features AS PERMISSIVE FOR ALL TO ebda_app
  USING (store_id = nullif(current_setting('app.current_store_id', true), ''))
  WITH CHECK (store_id = nullif(current_setting('app.current_store_id', true), ''));
ALTER TABLE store_howtos ENABLE ROW LEVEL SECURITY;
ALTER TABLE store_howtos FORCE ROW LEVEL SECURITY;
CREATE POLICY ebda_tenant_isolation ON store_howtos AS PERMISSIVE FOR ALL TO ebda_app
  USING (store_id = nullif(current_setting('app.current_store_id', true), ''))
  WITH CHECK (store_id = nullif(current_setting('app.current_store_id', true), ''));
ALTER TABLE store_locations ENABLE ROW LEVEL SECURITY;
ALTER TABLE store_locations FORCE ROW LEVEL SECURITY;
CREATE POLICY ebda_tenant_isolation ON store_locations AS PERMISSIVE FOR ALL TO ebda_app
  USING (store_id = nullif(current_setting('app.current_store_id', true), ''))
  WITH CHECK (store_id = nullif(current_setting('app.current_store_id', true), ''));
ALTER TABLE store_pages ENABLE ROW LEVEL SECURITY;
ALTER TABLE store_pages FORCE ROW LEVEL SECURITY;
CREATE POLICY ebda_tenant_isolation ON store_pages AS PERMISSIVE FOR ALL TO ebda_app
  USING (store_id = nullif(current_setting('app.current_store_id', true), ''))
  WITH CHECK (store_id = nullif(current_setting('app.current_store_id', true), ''));
ALTER TABLE store_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE store_subscriptions FORCE ROW LEVEL SECURITY;
CREATE POLICY ebda_tenant_isolation ON store_subscriptions AS PERMISSIVE FOR ALL TO ebda_app
  USING (store_id = nullif(current_setting('app.current_store_id', true), ''))
  WITH CHECK (store_id = nullif(current_setting('app.current_store_id', true), ''));
ALTER TABLE store_usage_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE store_usage_snapshots FORCE ROW LEVEL SECURITY;
CREATE POLICY ebda_tenant_isolation ON store_usage_snapshots AS PERMISSIVE FOR ALL TO ebda_app
  USING (store_id = nullif(current_setting('app.current_store_id', true), ''))
  WITH CHECK (store_id = nullif(current_setting('app.current_store_id', true), ''));
ALTER TABLE suppliers ENABLE ROW LEVEL SECURITY;
ALTER TABLE suppliers FORCE ROW LEVEL SECURITY;
CREATE POLICY ebda_tenant_isolation ON suppliers AS PERMISSIVE FOR ALL TO ebda_app
  USING (store_id = nullif(current_setting('app.current_store_id', true), ''))
  WITH CHECK (store_id = nullif(current_setting('app.current_store_id', true), ''));
ALTER TABLE tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE tags FORCE ROW LEVEL SECURITY;
CREATE POLICY ebda_tenant_isolation ON tags AS PERMISSIVE FOR ALL TO ebda_app
  USING (store_id = nullif(current_setting('app.current_store_id', true), ''))
  WITH CHECK (store_id = nullif(current_setting('app.current_store_id', true), ''));
ALTER TABLE tax_rates ENABLE ROW LEVEL SECURITY;
ALTER TABLE tax_rates FORCE ROW LEVEL SECURITY;
CREATE POLICY ebda_tenant_isolation ON tax_rates AS PERMISSIVE FOR ALL TO ebda_app
  USING (store_id = nullif(current_setting('app.current_store_id', true), ''))
  WITH CHECK (store_id = nullif(current_setting('app.current_store_id', true), ''));
ALTER TABLE wallet_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE wallet_transactions FORCE ROW LEVEL SECURITY;
CREATE POLICY ebda_tenant_isolation ON wallet_transactions AS PERMISSIVE FOR ALL TO ebda_app
  USING (store_id = nullif(current_setting('app.current_store_id', true), ''))
  WITH CHECK (store_id = nullif(current_setting('app.current_store_id', true), ''));
ALTER TABLE warehouse_stock ENABLE ROW LEVEL SECURITY;
ALTER TABLE warehouse_stock FORCE ROW LEVEL SECURITY;
CREATE POLICY ebda_tenant_isolation ON warehouse_stock AS PERMISSIVE FOR ALL TO ebda_app
  USING (store_id = nullif(current_setting('app.current_store_id', true), ''))
  WITH CHECK (store_id = nullif(current_setting('app.current_store_id', true), ''));
ALTER TABLE warehouses ENABLE ROW LEVEL SECURITY;
ALTER TABLE warehouses FORCE ROW LEVEL SECURITY;
CREATE POLICY ebda_tenant_isolation ON warehouses AS PERMISSIVE FOR ALL TO ebda_app
  USING (store_id = nullif(current_setting('app.current_store_id', true), ''))
  WITH CHECK (store_id = nullif(current_setting('app.current_store_id', true), ''));
ALTER TABLE webhook_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_events FORCE ROW LEVEL SECURITY;
CREATE POLICY ebda_tenant_isolation ON webhook_events AS PERMISSIVE FOR ALL TO ebda_app
  USING (store_id = nullif(current_setting('app.current_store_id', true), ''))
  WITH CHECK (store_id = nullif(current_setting('app.current_store_id', true), ''));
ALTER TABLE whatsapp_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_templates FORCE ROW LEVEL SECURITY;
CREATE POLICY ebda_tenant_isolation ON whatsapp_templates AS PERMISSIVE FOR ALL TO ebda_app
  USING (store_id = nullif(current_setting('app.current_store_id', true), ''))
  WITH CHECK (store_id = nullif(current_setting('app.current_store_id', true), ''));
ALTER TABLE wishlists ENABLE ROW LEVEL SECURITY;
ALTER TABLE wishlists FORCE ROW LEVEL SECURITY;
CREATE POLICY ebda_tenant_isolation ON wishlists AS PERMISSIVE FOR ALL TO ebda_app
  USING (store_id = nullif(current_setting('app.current_store_id', true), ''))
  WITH CHECK (store_id = nullif(current_setting('app.current_store_id', true), ''));

-- 4b. Table keyed by a camelCase storeId column.
ALTER TABLE "SlugRedirect" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SlugRedirect" FORCE ROW LEVEL SECURITY;
CREATE POLICY ebda_tenant_isolation ON "SlugRedirect" AS PERMISSIVE FOR ALL TO ebda_app
  USING ("storeId" = nullif(current_setting('app.current_store_id', true), ''))
  WITH CHECK ("storeId" = nullif(current_setting('app.current_store_id', true), ''));

-- 4c. Identity tables (see header for the exact rules).
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;
CREATE POLICY ebda_tenant_isolation ON users AS PERMISSIVE FOR ALL TO ebda_app
  USING (
    store_id = nullif(current_setting('app.current_store_id', true), '')
    OR id = nullif(current_setting('app.current_user_id', true), '')
    OR EXISTS (SELECT 1 FROM stores s WHERE s.owner_id = users.id AND s.id = nullif(current_setting('app.current_store_id', true), ''))
    OR EXISTS (SELECT 1 FROM store_staff ss WHERE ss.user_id = users.id AND ss.store_id = nullif(current_setting('app.current_store_id', true), ''))
    OR (SELECT public.ebda_is_super_admin())
  )
  WITH CHECK (
    store_id = nullif(current_setting('app.current_store_id', true), '')
    OR id = nullif(current_setting('app.current_user_id', true), '')
    OR (SELECT public.ebda_is_super_admin())
  );
ALTER TABLE store_staff ENABLE ROW LEVEL SECURITY;
ALTER TABLE store_staff FORCE ROW LEVEL SECURITY;
CREATE POLICY ebda_tenant_isolation ON store_staff AS PERMISSIVE FOR ALL TO ebda_app
  USING (store_id = nullif(current_setting('app.current_store_id', true), '') OR user_id = nullif(current_setting('app.current_user_id', true), ''))
  WITH CHECK (store_id = nullif(current_setting('app.current_store_id', true), ''));
ALTER TABLE system_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE system_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY ebda_tenant_isolation ON system_settings AS PERMISSIVE FOR ALL TO ebda_app
  USING (true)
  WITH CHECK (true);
ALTER TABLE addresses ENABLE ROW LEVEL SECURITY;
ALTER TABLE addresses FORCE ROW LEVEL SECURITY;
CREATE POLICY ebda_tenant_isolation ON addresses AS PERMISSIVE FOR ALL TO ebda_app
  USING (user_id = nullif(current_setting('app.current_user_id', true), ''))
  WITH CHECK (user_id = nullif(current_setting('app.current_user_id', true), ''));

-- 4d. Child tables without store_id: visible only through a parent in the transaction-local store.
ALTER TABLE bundle_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE bundle_items FORCE ROW LEVEL SECURITY;
CREATE POLICY ebda_tenant_isolation ON bundle_items AS PERMISSIVE FOR ALL TO ebda_app
  USING (EXISTS (SELECT 1 FROM bundles p WHERE p.id = bundle_items.bundle_id AND p.store_id = nullif(current_setting('app.current_store_id', true), '')))
  WITH CHECK (EXISTS (SELECT 1 FROM bundles p WHERE p.id = bundle_items.bundle_id AND p.store_id = nullif(current_setting('app.current_store_id', true), '')));
ALTER TABLE cart_bundles ENABLE ROW LEVEL SECURITY;
ALTER TABLE cart_bundles FORCE ROW LEVEL SECURITY;
CREATE POLICY ebda_tenant_isolation ON cart_bundles AS PERMISSIVE FOR ALL TO ebda_app
  USING (EXISTS (SELECT 1 FROM carts p WHERE p.id = cart_bundles.cart_id AND p.store_id = nullif(current_setting('app.current_store_id', true), '')))
  WITH CHECK (EXISTS (SELECT 1 FROM carts p WHERE p.id = cart_bundles.cart_id AND p.store_id = nullif(current_setting('app.current_store_id', true), '')));
ALTER TABLE cart_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE cart_items FORCE ROW LEVEL SECURITY;
CREATE POLICY ebda_tenant_isolation ON cart_items AS PERMISSIVE FOR ALL TO ebda_app
  USING (EXISTS (SELECT 1 FROM carts p WHERE p.id = cart_items.cart_id AND p.store_id = nullif(current_setting('app.current_store_id', true), '')))
  WITH CHECK (EXISTS (SELECT 1 FROM carts p WHERE p.id = cart_items.cart_id AND p.store_id = nullif(current_setting('app.current_store_id', true), '')));
ALTER TABLE count_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE count_lines FORCE ROW LEVEL SECURITY;
CREATE POLICY ebda_tenant_isolation ON count_lines AS PERMISSIVE FOR ALL TO ebda_app
  USING (EXISTS (SELECT 1 FROM count_sessions p WHERE p.id = count_lines.session_id AND p.store_id = nullif(current_setting('app.current_store_id', true), '')))
  WITH CHECK (EXISTS (SELECT 1 FROM count_sessions p WHERE p.id = count_lines.session_id AND p.store_id = nullif(current_setting('app.current_store_id', true), '')));
ALTER TABLE customer_addresses ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_addresses FORCE ROW LEVEL SECURITY;
CREATE POLICY ebda_tenant_isolation ON customer_addresses AS PERMISSIVE FOR ALL TO ebda_app
  USING (EXISTS (SELECT 1 FROM customers p WHERE p.id = customer_addresses.customer_id AND p.store_id = nullif(current_setting('app.current_store_id', true), '')))
  WITH CHECK (EXISTS (SELECT 1 FROM customers p WHERE p.id = customer_addresses.customer_id AND p.store_id = nullif(current_setting('app.current_store_id', true), '')));
ALTER TABLE journal_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE journal_lines FORCE ROW LEVEL SECURITY;
CREATE POLICY ebda_tenant_isolation ON journal_lines AS PERMISSIVE FOR ALL TO ebda_app
  USING (EXISTS (SELECT 1 FROM journal_entries p WHERE p.id = journal_lines.entry_id AND p.store_id = nullif(current_setting('app.current_store_id', true), '')))
  WITH CHECK (EXISTS (SELECT 1 FROM journal_entries p WHERE p.id = journal_lines.entry_id AND p.store_id = nullif(current_setting('app.current_store_id', true), '')));
ALTER TABLE order_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_items FORCE ROW LEVEL SECURITY;
CREATE POLICY ebda_tenant_isolation ON order_items AS PERMISSIVE FOR ALL TO ebda_app
  USING (EXISTS (SELECT 1 FROM orders p WHERE p.id = order_items.order_id AND p.store_id = nullif(current_setting('app.current_store_id', true), '')))
  WITH CHECK (EXISTS (SELECT 1 FROM orders p WHERE p.id = order_items.order_id AND p.store_id = nullif(current_setting('app.current_store_id', true), '')));
ALTER TABLE payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments FORCE ROW LEVEL SECURITY;
CREATE POLICY ebda_tenant_isolation ON payments AS PERMISSIVE FOR ALL TO ebda_app
  USING (EXISTS (SELECT 1 FROM orders p WHERE p.id = payments.order_id AND p.store_id = nullif(current_setting('app.current_store_id', true), '')))
  WITH CHECK (EXISTS (SELECT 1 FROM orders p WHERE p.id = payments.order_id AND p.store_id = nullif(current_setting('app.current_store_id', true), '')));
ALTER TABLE product_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_categories FORCE ROW LEVEL SECURITY;
CREATE POLICY ebda_tenant_isolation ON product_categories AS PERMISSIVE FOR ALL TO ebda_app
  USING (EXISTS (SELECT 1 FROM products p WHERE p.id = product_categories.product_id AND p.store_id = nullif(current_setting('app.current_store_id', true), '')))
  WITH CHECK (EXISTS (SELECT 1 FROM products p WHERE p.id = product_categories.product_id AND p.store_id = nullif(current_setting('app.current_store_id', true), '')));
ALTER TABLE product_faqs ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_faqs FORCE ROW LEVEL SECURITY;
CREATE POLICY ebda_tenant_isolation ON product_faqs AS PERMISSIVE FOR ALL TO ebda_app
  USING (EXISTS (SELECT 1 FROM products p WHERE p.id = product_faqs.product_id AND p.store_id = nullif(current_setting('app.current_store_id', true), '')))
  WITH CHECK (EXISTS (SELECT 1 FROM products p WHERE p.id = product_faqs.product_id AND p.store_id = nullif(current_setting('app.current_store_id', true), '')));
ALTER TABLE product_images ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_images FORCE ROW LEVEL SECURITY;
CREATE POLICY ebda_tenant_isolation ON product_images AS PERMISSIVE FOR ALL TO ebda_app
  USING (EXISTS (SELECT 1 FROM products p WHERE p.id = product_images.product_id AND p.store_id = nullif(current_setting('app.current_store_id', true), '')))
  WITH CHECK (EXISTS (SELECT 1 FROM products p WHERE p.id = product_images.product_id AND p.store_id = nullif(current_setting('app.current_store_id', true), '')));
ALTER TABLE product_options ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_options FORCE ROW LEVEL SECURITY;
CREATE POLICY ebda_tenant_isolation ON product_options AS PERMISSIVE FOR ALL TO ebda_app
  USING (EXISTS (SELECT 1 FROM products p WHERE p.id = product_options.product_id AND p.store_id = nullif(current_setting('app.current_store_id', true), '')))
  WITH CHECK (EXISTS (SELECT 1 FROM products p WHERE p.id = product_options.product_id AND p.store_id = nullif(current_setting('app.current_store_id', true), '')));
ALTER TABLE product_tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_tags FORCE ROW LEVEL SECURITY;
CREATE POLICY ebda_tenant_isolation ON product_tags AS PERMISSIVE FOR ALL TO ebda_app
  USING (EXISTS (SELECT 1 FROM products p WHERE p.id = product_tags.product_id AND p.store_id = nullif(current_setting('app.current_store_id', true), '')))
  WITH CHECK (EXISTS (SELECT 1 FROM products p WHERE p.id = product_tags.product_id AND p.store_id = nullif(current_setting('app.current_store_id', true), '')));
ALTER TABLE product_variants ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_variants FORCE ROW LEVEL SECURITY;
CREATE POLICY ebda_tenant_isolation ON product_variants AS PERMISSIVE FOR ALL TO ebda_app
  USING (EXISTS (SELECT 1 FROM products p WHERE p.id = product_variants.product_id AND p.store_id = nullif(current_setting('app.current_store_id', true), '')))
  WITH CHECK (EXISTS (SELECT 1 FROM products p WHERE p.id = product_variants.product_id AND p.store_id = nullif(current_setting('app.current_store_id', true), '')));
ALTER TABLE purchase_order_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchase_order_items FORCE ROW LEVEL SECURITY;
CREATE POLICY ebda_tenant_isolation ON purchase_order_items AS PERMISSIVE FOR ALL TO ebda_app
  USING (EXISTS (SELECT 1 FROM purchase_orders p WHERE p.id = purchase_order_items.po_id AND p.store_id = nullif(current_setting('app.current_store_id', true), '')))
  WITH CHECK (EXISTS (SELECT 1 FROM purchase_orders p WHERE p.id = purchase_order_items.po_id AND p.store_id = nullif(current_setting('app.current_store_id', true), '')));
ALTER TABLE return_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE return_items FORCE ROW LEVEL SECURITY;
CREATE POLICY ebda_tenant_isolation ON return_items AS PERMISSIVE FOR ALL TO ebda_app
  USING (EXISTS (SELECT 1 FROM returns p WHERE p.id = return_items.return_id AND p.store_id = nullif(current_setting('app.current_store_id', true), '')))
  WITH CHECK (EXISTS (SELECT 1 FROM returns p WHERE p.id = return_items.return_id AND p.store_id = nullif(current_setting('app.current_store_id', true), '')));
ALTER TABLE stock_adjustment_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_adjustment_items FORCE ROW LEVEL SECURITY;
CREATE POLICY ebda_tenant_isolation ON stock_adjustment_items AS PERMISSIVE FOR ALL TO ebda_app
  USING (EXISTS (SELECT 1 FROM stock_adjustments p WHERE p.id = stock_adjustment_items.adjustment_id AND p.store_id = nullif(current_setting('app.current_store_id', true), '')))
  WITH CHECK (EXISTS (SELECT 1 FROM stock_adjustments p WHERE p.id = stock_adjustment_items.adjustment_id AND p.store_id = nullif(current_setting('app.current_store_id', true), '')));
ALTER TABLE wishlist_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE wishlist_items FORCE ROW LEVEL SECURITY;
CREATE POLICY ebda_tenant_isolation ON wishlist_items AS PERMISSIVE FOR ALL TO ebda_app
  USING (EXISTS (SELECT 1 FROM wishlists p WHERE p.id = wishlist_items.wishlist_id AND p.store_id = nullif(current_setting('app.current_store_id', true), '')))
  WITH CHECK (EXISTS (SELECT 1 FROM wishlists p WHERE p.id = wishlist_items.wishlist_id AND p.store_id = nullif(current_setting('app.current_store_id', true), '')));
ALTER TABLE product_option_values ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_option_values FORCE ROW LEVEL SECURITY;
CREATE POLICY ebda_tenant_isolation ON product_option_values AS PERMISSIVE FOR ALL TO ebda_app
  USING (EXISTS (SELECT 1 FROM product_options m JOIN products p ON p.id = m.product_id WHERE m.id = product_option_values.option_id AND p.store_id = nullif(current_setting('app.current_store_id', true), '')))
  WITH CHECK (EXISTS (SELECT 1 FROM product_options m JOIN products p ON p.id = m.product_id WHERE m.id = product_option_values.option_id AND p.store_id = nullif(current_setting('app.current_store_id', true), '')));
ALTER TABLE product_variant_options ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_variant_options FORCE ROW LEVEL SECURITY;
CREATE POLICY ebda_tenant_isolation ON product_variant_options AS PERMISSIVE FOR ALL TO ebda_app
  USING (EXISTS (SELECT 1 FROM product_variants m JOIN products p ON p.id = m.product_id WHERE m.id = product_variant_options.variant_id AND p.store_id = nullif(current_setting('app.current_store_id', true), '')))
  WITH CHECK (EXISTS (SELECT 1 FROM product_variants m JOIN products p ON p.id = m.product_id WHERE m.id = product_variant_options.variant_id AND p.store_id = nullif(current_setting('app.current_store_id', true), '')));

-- ---------------------------------------------------------------------------
-- 5. SECURITY DEFINER functions: the ONLY way ebda_app reaches data BEFORE a
--    store or user is known, or across stores. They replace FWB's
--    `app.bypass_rls` GUC. Rules for every function here:
--      - owned by the migration owner (which bypasses RLS), so they see all rows;
--      - fixed `search_path` (pg_temp last), everything schema-qualified;
--      - narrow: an exact-key lookup or one named mutation, never a table dump,
--        never dynamic SQL;
--      - EXECUTE revoked from PUBLIC and granted to ebda_app only.
-- ---------------------------------------------------------------------------

-- 5.1 host -> store. Exact slug or custom-domain match on an ACTIVE store; a slug
--     match wins over a domain match. Returns the id only. UNGUARDED ON PURPOSE:
--     it runs before any scope exists and the host it resolves is public.
CREATE OR REPLACE FUNCTION public.ebda_resolve_store_id(p_slug text, p_domain text)
RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
  SELECT s.id
  FROM public.stores s
  WHERE s.status = 'active'
    AND ((p_slug IS NOT NULL AND s.slug = p_slug)
      OR (p_domain IS NOT NULL AND s.domain = p_domain))
  ORDER BY (p_slug IS NOT NULL AND s.slug = p_slug) DESC
  LIMIT 1
$fn$;

-- 5.2 identity, by exact id: the facts an access-token check needs.
--     UNGUARDED ON PURPOSE: it runs on every request BEFORE any user or store
--     scope exists (it is what authenticates the token), the id is the signed
--     token's subject, and it returns no secret (no email, no hash).
CREATE OR REPLACE FUNCTION public.ebda_user_state(p_user_id text)
RETURNS TABLE (id text, role text, status text, token_version integer, store_id text, deleted_at timestamp)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
  SELECT u.id, u.role::text, u.status::text, u.token_version, u.store_id, u.deleted_at
  FROM public.users u
  WHERE u.id = p_user_id
$fn$;

-- 5.3 login/registration lookup: email -> user id inside ONE namespace
--     (p_store_id NULL = the admin namespace). Soft-deleted users are excluded
--     unless p_include_deleted. Returns the id only; the caller then reads the
--     row under its own user scope. UNGUARDED ON PURPOSE: login, registration
--     and signup have no principal yet, and an id alone discloses nothing.
--     p_case_insensitive matches the email regardless of case (merchant signup).
CREATE OR REPLACE FUNCTION public.ebda_auth_find_user_id(
  p_email text, p_store_id text, p_include_deleted boolean DEFAULT false,
  p_case_insensitive boolean DEFAULT false
)
RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
  SELECT u.id
  FROM public.users u
  WHERE (u.email = p_email OR (p_case_insensitive AND lower(u.email) = lower(p_email)))
    AND u.store_id IS NOT DISTINCT FROM p_store_id
    AND (p_include_deleted OR u.deleted_at IS NULL)
  LIMIT 1
$fn$;

-- 5.3b find-or-create an ADMIN-namespace account (users.store_id NULL): store
--      owners and staff. Returns an existing account untouched; otherwise creates
--      a store_admin/staff account. Refuses every other role, so it can never mint
--      a super_admin or a customer. UNGUARDED ON PURPOSE (signup and provisioning
--      have no principal) but it returns ids and flags only, never another
--      person's name or email, so an existing address leaks nothing it was not
--      asked about.
CREATE OR REPLACE FUNCTION public.ebda_admin_user_ensure(
  p_email text, p_password_hash text, p_first_name text, p_last_name text,
  p_role text, p_email_verified boolean DEFAULT false
)
RETURNS TABLE (user_id text, created boolean, role text, status text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  v public.users%ROWTYPE;
BEGIN
  IF p_role NOT IN ('store_admin', 'staff') THEN
    RAISE EXCEPTION 'ebda_admin_user_ensure: role % is not allowed', p_role;
  END IF;
  SELECT * INTO v FROM public.users u
   WHERE u.email = p_email AND u.store_id IS NULL
   ORDER BY u.created_at LIMIT 1;
  IF FOUND THEN
    RETURN QUERY SELECT v.id, false, v.role::text, v.status::text;
    RETURN;
  END IF;
  INSERT INTO public.users
    (id, email, password_hash, first_name, last_name, role, store_id, email_verified, updated_at)
  VALUES
    (gen_random_uuid()::text, p_email, p_password_hash, p_first_name, p_last_name,
     p_role::public."UserRole", NULL, p_email_verified, now())
  RETURNING * INTO v;
  RETURN QUERY SELECT v.id, true, v.role::text, v.status::text;
END
$fn$;

-- 5.4 audit trail: append-only through a definer. UNGUARDED ON PURPOSE: platform
--     events (failed logins, signup) have no principal and a super-admin logs
--     against stores it is not scoped to; the function can only ADD a row, never
--     read, change or remove one. audit_logs is store-scoped
--     under RLS, but platform events (login failures, super-admin actions) have
--     no store, and a request may log against a store other than its own. ebda_app
--     can still SELECT its store's rows; it can no longer rewrite history of
--     rows it did not create in scope (see 5.5 for the one detach path).
CREATE OR REPLACE FUNCTION public.ebda_audit_log_insert(
  p_id text, p_action text, p_user_id text, p_store_id text, p_resource_type text,
  p_resource_id text, p_details jsonb, p_ip text, p_user_agent text
)
RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
BEGIN
  INSERT INTO public.audit_logs
    (id, action, user_id, store_id, resource_type, resource_id, details, ip_address, user_agent)
  VALUES
    (p_id, p_action, p_user_id, p_store_id, p_resource_type, p_resource_id,
     COALESCE(p_details, '{}'::jsonb), p_ip, p_user_agent);
  RETURN true;
END
$fn$;

-- 5.5 audit-trail maintenance on delete: nulling store_id / user_id leaves the
--     caller's store scope (WITH CHECK would reject it), so these two narrow
--     mutations are definers. Both return the number of rows changed.
--     GUARDED: detach_store only for the store the transaction is scoped to (or a
--     super_admin); unlink_user only for a user the caller may act on
--     (ebda_may_act_on_user). Otherwise SQLSTATE 42501.
CREATE OR REPLACE FUNCTION public.ebda_audit_logs_detach_store(p_store_id text)
RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  v_n integer;
BEGIN
  IF p_store_id IS NULL OR NOT (
       coalesce(p_store_id = nullif(current_setting('app.current_store_id', true), ''), false)
       OR public.ebda_is_super_admin()) THEN
    RAISE EXCEPTION 'ebda_audit_logs_detach_store: caller is not scoped to store %', p_store_id
      USING ERRCODE = '42501';
  END IF;
  UPDATE public.audit_logs a SET store_id = NULL WHERE a.store_id = p_store_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END
$fn$;

CREATE OR REPLACE FUNCTION public.ebda_audit_logs_unlink_user(p_user_id text)
RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  v_n integer;
BEGIN
  IF NOT public.ebda_may_act_on_user(p_user_id) THEN
    RAISE EXCEPTION 'ebda_audit_logs_unlink_user: caller may not act on user %', p_user_id
      USING ERRCODE = '42501';
  END IF;
  UPDATE public.audit_logs a SET user_id = NULL WHERE a.user_id = p_user_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END
$fn$;

-- 5.5b existence probe on the audit trail for a (action, resource) pair: some
--      historical rows (e.g. order.admin_created) carry NO store, so a store-scoped
--      read cannot see them. Returns a boolean only.
CREATE OR REPLACE FUNCTION public.ebda_audit_log_exists(p_action text, p_resource_type text, p_resource_id text)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
  SELECT EXISTS (
    SELECT 1 FROM public.audit_logs a
    WHERE a.action = p_action AND a.resource_type = p_resource_type AND a.resource_id = p_resource_id
  )
$fn$;

-- 5.5c retention of the audit trail (weekly cron): count / export / purge rows
--      older than a cutoff, across every store and the store-less platform rows.
--      A cutoff newer than 30 days is refused, so a stolen role cannot use the
--      purge to erase recent history. GUARDED: only an ACTIVE super_admin or the
--      `audit-log-retention` system job (the weekly cron, which has no user and no
--      store) may call these; anyone else gets SQLSTATE 42501.
CREATE OR REPLACE FUNCTION public.ebda_audit_log_retention_count(p_cutoff timestamp)
RETURNS bigint
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
BEGIN
  IF NOT (public.ebda_is_super_admin() OR public.ebda_is_system_job('audit-log-retention')) THEN
    RAISE EXCEPTION 'ebda_audit_log_retention_*: caller is neither a super_admin nor the retention job'
      USING ERRCODE = '42501';
  END IF;
  IF p_cutoff > now() - interval '30 days' THEN
    RAISE EXCEPTION 'ebda_audit_log_retention_*: cutoff must be at least 30 days old';
  END IF;
  RETURN (SELECT count(*) FROM public.audit_logs a WHERE a.created_at < p_cutoff);
END
$fn$;

CREATE OR REPLACE FUNCTION public.ebda_audit_log_retention_page(p_cutoff timestamp, p_after_id text, p_limit integer)
RETURNS SETOF public.audit_logs
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
BEGIN
  IF NOT (public.ebda_is_super_admin() OR public.ebda_is_system_job('audit-log-retention')) THEN
    RAISE EXCEPTION 'ebda_audit_log_retention_*: caller is neither a super_admin nor the retention job'
      USING ERRCODE = '42501';
  END IF;
  IF p_cutoff > now() - interval '30 days' THEN
    RAISE EXCEPTION 'ebda_audit_log_retention_*: cutoff must be at least 30 days old';
  END IF;
  RETURN QUERY
    SELECT * FROM public.audit_logs a
    WHERE a.created_at < p_cutoff AND (p_after_id IS NULL OR a.id > p_after_id)
    ORDER BY a.id ASC
    LIMIT GREATEST(p_limit, 0);
END
$fn$;

CREATE OR REPLACE FUNCTION public.ebda_audit_log_retention_purge(p_cutoff timestamp, p_limit integer)
RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  v_n integer;
BEGIN
  IF NOT (public.ebda_is_super_admin() OR public.ebda_is_system_job('audit-log-retention')) THEN
    RAISE EXCEPTION 'ebda_audit_log_retention_*: caller is neither a super_admin nor the retention job'
      USING ERRCODE = '42501';
  END IF;
  IF p_cutoff > now() - interval '30 days' THEN
    RAISE EXCEPTION 'ebda_audit_log_retention_*: cutoff must be at least 30 days old';
  END IF;
  DELETE FROM public.audit_logs a
   WHERE a.id IN (SELECT x.id FROM public.audit_logs x WHERE x.created_at < p_cutoff LIMIT GREATEST(p_limit, 0));
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END
$fn$;

-- 5.6 payment-webhook routing. A provider's callback names a provider reference,
--     not a store, so the store is discovered BEFORE any scope exists.
--     UNGUARDED ON PURPOSE (a, b, c): a provider callback names a reference, not a
--     principal, so no store or user can be set yet; each returns ids / flags for
--     an exact, unguessable provider reference and nothing else.
--     (a) provider reference -> store id (exact match on payments.transaction_id
--         or payments.invoice_id; returns the store id only).
CREATE OR REPLACE FUNCTION public.ebda_webhook_resolve_store(p_transaction_id text, p_invoice_id text)
RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
  SELECT o.store_id
  FROM public.payments p
  JOIN public.orders o ON o.id = p.order_id
  WHERE (p_transaction_id IS NOT NULL AND p.transaction_id = p_transaction_id)
     OR (p_invoice_id IS NOT NULL AND p.invoice_id = p_invoice_id)
  LIMIT 1
$fn$;

--     (b) idempotency key -> the order it already settled (exact match).
CREATE OR REPLACE FUNCTION public.ebda_webhook_order_by_idempotency(p_key text)
RETURNS TABLE (order_id text, store_id text, webhook_processed_at timestamp)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
  SELECT o.id, o.store_id, o.webhook_processed_at
  FROM public.orders o
  WHERE p_key IS NOT NULL AND o.idempotency_key = p_key
$fn$;

--     (c) order id -> its store id (a webhook handler that produced an order id).
CREATE OR REPLACE FUNCTION public.ebda_order_store_id(p_order_id text)
RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
  SELECT o.store_id FROM public.orders o WHERE o.id = p_order_id
$fn$;

-- 5.7 the webhook inbox (webhook_events). store_id is NULL on the platform path,
--     and the consumer must read a row before it can enter a store scope, so
--     every inbox operation is a definer keyed by the row id / idempotency key.
--     (a) record: UNGUARDED ON PURPOSE (it IS the public ingress: the provider's
--         callback has no principal); it only inserts, or refreshes a row that is
--         not yet processed, and never touches a processed one. First delivery
--         inserts; a redelivery refreshes the volatile
--         fields of a row that is NOT yet processed and leaves a processed row
--         untouched. Returns the row id.
CREATE OR REPLACE FUNCTION public.ebda_webhook_inbox_record(
  p_id text, p_provider text, p_idempotency_key text, p_store_id text,
  p_payload jsonb, p_raw_body text, p_signature text
)
RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  v_id text;
BEGIN
  INSERT INTO public.webhook_events
    (id, provider, idempotency_key, store_id, payload, raw_body, signature, status, updated_at)
  VALUES
    (p_id, p_provider, p_idempotency_key, p_store_id, p_payload, p_raw_body, p_signature, 'received', now())
  ON CONFLICT (idempotency_key) DO UPDATE
    SET payload = EXCLUDED.payload, raw_body = EXCLUDED.raw_body,
        signature = EXCLUDED.signature, store_id = EXCLUDED.store_id, updated_at = now()
    WHERE public.webhook_events.status <> 'processed'
  RETURNING id INTO v_id;
  IF v_id IS NULL THEN
    SELECT w.id INTO v_id FROM public.webhook_events w WHERE w.idempotency_key = p_idempotency_key;
  END IF;
  RETURN v_id;
END
$fn$;

--     (b) read one row by id (payload, raw body, signature). GUARDED: an ACTIVE
--         super_admin (the inbox viewer) or the `webhook-inbox` system job (the
--         consumer, which must read the row before it knows the store).
CREATE OR REPLACE FUNCTION public.ebda_webhook_inbox_get(p_id text)
RETURNS SETOF public.webhook_events
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
BEGIN
  IF NOT (public.ebda_is_super_admin() OR public.ebda_is_system_job('webhook-inbox')) THEN
    RAISE EXCEPTION 'ebda_webhook_inbox_get: caller is neither a super_admin nor the webhook consumer'
      USING ERRCODE = '42501';
  END IF;
  RETURN QUERY SELECT * FROM public.webhook_events w WHERE w.id = p_id;
END
$fn$;

--     (c) advance one row's processing state. Only these columns can change.
--         GUARDED like (b): super_admin (requeue from the viewer) or the
--         `webhook-inbox` system job (the consumer).
CREATE OR REPLACE FUNCTION public.ebda_webhook_inbox_update(
  p_id text,
  p_status text DEFAULT NULL,
  p_last_error text DEFAULT NULL,
  p_increment_attempts boolean DEFAULT false,
  p_mark_processed boolean DEFAULT false,
  p_result_order_id text DEFAULT NULL,
  p_result_status text DEFAULT NULL,
  p_requeue boolean DEFAULT false
)
RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
BEGIN
  IF NOT (public.ebda_is_super_admin() OR public.ebda_is_system_job('webhook-inbox')) THEN
    RAISE EXCEPTION 'ebda_webhook_inbox_update: caller is neither a super_admin nor the webhook consumer'
      USING ERRCODE = '42501';
  END IF;
  UPDATE public.webhook_events w SET
    status = CASE WHEN p_requeue THEN 'received' ELSE COALESCE(p_status, w.status) END,
    attempts = CASE WHEN p_requeue THEN 0 ELSE w.attempts + CASE WHEN p_increment_attempts THEN 1 ELSE 0 END END,
    last_error = CASE WHEN p_requeue OR p_mark_processed THEN NULL
                      WHEN p_last_error IS NOT NULL THEN p_last_error ELSE w.last_error END,
    received_at = CASE WHEN p_requeue THEN now() ELSE w.received_at END,
    processed_at = CASE WHEN p_mark_processed THEN now() ELSE w.processed_at END,
    result_order_id = CASE WHEN p_mark_processed THEN p_result_order_id ELSE w.result_order_id END,
    result_status = CASE WHEN p_mark_processed THEN p_result_status ELSE w.result_status END,
    updated_at = now()
  WHERE w.id = p_id;
  RETURN FOUND;
END
$fn$;

--     (d) rows that never got consumed or wedged (the stuck-row sweep). GUARDED
--         like (b): a cross-store listing, so super_admin or the `webhook-inbox`
--         system job (the sweep cron).
CREATE OR REPLACE FUNCTION public.ebda_webhook_inbox_stuck(p_cutoff timestamp, p_limit integer)
RETURNS TABLE (id text, provider text, idempotency_key text, store_id text, status text, attempts integer, received_at timestamp)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
BEGIN
  IF NOT (public.ebda_is_super_admin() OR public.ebda_is_system_job('webhook-inbox')) THEN
    RAISE EXCEPTION 'ebda_webhook_inbox_stuck: caller is neither a super_admin nor the webhook sweep'
      USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT w.id, w.provider, w.idempotency_key, w.store_id, w.status, w.attempts, w.received_at
  FROM public.webhook_events w
  WHERE w.status IN ('received', 'processing') AND w.received_at < p_cutoff
  ORDER BY w.received_at ASC
  LIMIT GREATEST(p_limit, 0);
END
$fn$;

--     (e) super-admin inbox viewer: filtered page + total. Only an ACTIVE
--         super_admin may call it (checked against p_actor_user_id), and every
--         call leaves an audit row, so this cross-store read is explicit.
CREATE OR REPLACE FUNCTION public.ebda_platform_webhook_inbox_list(
  p_actor_user_id text, p_status text, p_provider text, p_limit integer, p_offset integer
)
RETURNS TABLE (
  id text, provider text, store_id text, status text, attempts integer, last_error text,
  result_order_id text, result_status text, idempotency_key text, received_at timestamp, total bigint
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.users u
                 WHERE u.id = p_actor_user_id AND u.role = 'super_admin'
                   AND u.status = 'active' AND u.deleted_at IS NULL) THEN
    RAISE EXCEPTION 'ebda_platform_webhook_inbox_list: actor is not an active super_admin';
  END IF;
  INSERT INTO public.audit_logs (id, action, user_id, resource_type, details)
  VALUES (gen_random_uuid()::text, 'platform.cross_store_read', p_actor_user_id, 'webhook_events',
          jsonb_build_object('fn', 'ebda_platform_webhook_inbox_list', 'status', p_status, 'provider', p_provider));
  RETURN QUERY
  SELECT w.id, w.provider, w.store_id, w.status, w.attempts, w.last_error, w.result_order_id,
         w.result_status, w.idempotency_key, w.received_at, count(*) OVER () AS total
  FROM public.webhook_events w
  WHERE (p_status IS NULL OR w.status = p_status)
    AND (p_provider IS NULL OR w.provider = p_provider)
  ORDER BY w.received_at DESC
  LIMIT GREATEST(p_limit, 0) OFFSET GREATEST(p_offset, 0);
END
$fn$;

--     (f) UNGUARDED ON PURPOSE: the shopper's browser comes back from the payment
--         page with no session; it returns the store's PUBLIC slug and domain only.
--         payment-redirect callbacks carry only the provider's transaction id
--         (matched against the order's idempotency key / id): the storefront
--         origin to send the shopper back to is the store's slug and domain.
CREATE OR REPLACE FUNCTION public.ebda_storefront_for_payment_ref(p_ref text)
RETURNS TABLE (slug text, domain text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
  SELECT s.slug, s.domain
  FROM public.orders o
  JOIN public.stores s ON s.id = o.store_id
  WHERE p_ref IS NOT NULL AND length(p_ref) > 0
    AND (o.id = p_ref OR strpos(o.idempotency_key, p_ref) > 0)
  ORDER BY o.created_at DESC
  LIMIT 1
$fn$;

-- 5.8 shipping-carrier webhooks identify a parcel by tracking number only.
--     UNGUARDED ON PURPOSE: a carrier callback has no principal; returns a store id.
CREATE OR REPLACE FUNCTION public.ebda_shipment_store_id_by_tracking(p_tracking_number text)
RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
  SELECT sh.store_id
  FROM public.shipments sh
  WHERE p_tracking_number IS NOT NULL AND sh.tracking_number = p_tracking_number
  LIMIT 1
$fn$;

-- 5.9 identity operations that cross the user/store boundary. All of them run in
--     the caller's transaction (a definer is just a function call), so a request
--     transaction stays atomic with them.
--     (a) "sign out everywhere": bump token_version and revoke the user's
--         merchant MCP keys in EVERY store. NULL when the user does not exist.
--         GUARDED (ebda_may_act_on_user): the user themself (logout-all, password
--         change, MFA change, and the password reset once its token is validated,
--         which runs under withUser(target)), a super_admin, or a user of the
--         caller's own store; otherwise SQLSTATE 42501.
CREATE OR REPLACE FUNCTION public.ebda_user_revoke_sessions(p_user_id text)
RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  v_tv integer;
BEGIN
  IF NOT public.ebda_may_act_on_user(p_user_id) THEN
    RAISE EXCEPTION 'ebda_user_revoke_sessions: caller may not act on user %', p_user_id
      USING ERRCODE = '42501';
  END IF;
  UPDATE public.users u
     SET token_version = u.token_version + 1, updated_at = now()
   WHERE u.id = p_user_id
  RETURNING u.token_version INTO v_tv;
  IF v_tv IS NULL THEN
    RETURN NULL;
  END IF;
  UPDATE public.merchant_api_keys k
     SET revoked_at = now(), updated_at = now()
   WHERE k.user_id = p_user_id AND k.revoked_at IS NULL;
  RETURN v_tv;
END
$fn$;

--     (b) erasure of a user's own addresses. `addresses` is scoped to
--         app.current_user_id, but a MERCHANT erasing a customer runs with the
--         merchant's user id set, so a plain DELETE would silently match zero rows.
--         GUARDED like (a): the shopper themself, a super_admin, or the merchant
--         whose store the shopper belongs to; otherwise SQLSTATE 42501.
CREATE OR REPLACE FUNCTION public.ebda_user_addresses_delete(p_user_id text)
RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  v_n integer;
BEGIN
  IF NOT public.ebda_may_act_on_user(p_user_id) THEN
    RAISE EXCEPTION 'ebda_user_addresses_delete: caller may not act on user %', p_user_id
      USING ERRCODE = '42501';
  END IF;
  DELETE FROM public.addresses a WHERE a.user_id = p_user_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END
$fn$;

-- 5.10 platform operator reads. (b) takes the acting user id and refuses anyone
--      who is not an ACTIVE super_admin (a data check, not a flag); (a) is an
--      id -> id lookup used by the background jobs, listed here so the cross-store
--      surface stays small and reviewable.
--      (a) which store owns a product / order / customer / journal entry id (exact
--          primary key). UNGUARDED ON PURPOSE: an Inngest event names a row before
--          any store is known, and the answer is a store id, never row data.
CREATE OR REPLACE FUNCTION public.ebda_entity_store_id(p_kind text, p_id text)
RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
  SELECT CASE p_kind
    WHEN 'product'  THEN (SELECT p.store_id FROM public.products  p WHERE p.id = p_id)
    WHEN 'order'    THEN (SELECT o.store_id FROM public.orders    o WHERE o.id = p_id)
    WHEN 'customer' THEN (SELECT c.store_id FROM public.customers c WHERE c.id = p_id)
    WHEN 'journal_entry' THEN (SELECT j.store_id FROM public.journal_entries j WHERE j.id = p_id)
    WHEN 'bulk_import_job' THEN (SELECT b.store_id FROM public.bulk_import_jobs b WHERE b.id = p_id)
  END
$fn$;

--      (b) the audit-log viewer: store-scoped rows AND platform events that have
--          no store (login failures, user management, impersonation).
CREATE OR REPLACE FUNCTION public.ebda_platform_audit_log_list(
  p_actor_user_id text, p_action text, p_user_id text, p_resource_type text,
  p_limit integer, p_offset integer
)
RETURNS TABLE (
  id text, action text, user_id text, store_id text, resource_type text, resource_id text,
  details jsonb, ip_address text, user_agent text, created_at timestamp,
  u_email text, u_first_name text, u_last_name text, total bigint
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.users u
                 WHERE u.id = p_actor_user_id AND u.role = 'super_admin'
                   AND u.status = 'active' AND u.deleted_at IS NULL) THEN
    RAISE EXCEPTION 'ebda_platform_audit_log_list: actor is not an active super_admin';
  END IF;
  RETURN QUERY
  SELECT a.id, a.action, a.user_id, a.store_id, a.resource_type, a.resource_id, a.details,
         a.ip_address, a.user_agent, a.created_at,
         u.email, u.first_name, u.last_name, count(*) OVER () AS total
  FROM public.audit_logs a
  LEFT JOIN public.users u ON u.id = a.user_id
  WHERE (p_action IS NULL OR strpos(a.action, p_action) > 0)
    AND (p_user_id IS NULL OR a.user_id = p_user_id)
    AND (p_resource_type IS NULL OR a.resource_type = p_resource_type)
  ORDER BY a.created_at DESC
  LIMIT GREATEST(p_limit, 0) OFFSET GREATEST(p_offset, 0);
END
$fn$;

-- 5.11 platform-wide AI usage counters. UNGUARDED ON PURPOSE: it returns one count. The global daily/monthly AI caps and the
--      paid answer-engine budget are cross-store AGGREGATES on a hot path (every
--      AI request); fanning out per store would cost one transaction per store
--      per call. The function returns a single count, never rows.
CREATE OR REPLACE FUNCTION public.ebda_ai_usage_count(
  p_since timestamp, p_cached_hit boolean, p_feature text DEFAULT NULL
)
RETURNS bigint
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
  SELECT count(*)
  FROM public.ai_usage a
  WHERE a.created_at >= p_since
    AND a.cached_hit = p_cached_hit
    AND (p_feature IS NULL OR a.feature = p_feature)
$fn$;

-- 5.12 SMS opt-out links name a consent row, not a store (the store is on the row).
--      UNGUARDED ON PURPOSE: the unguessable consent id in the link IS the
--      credential (the shopper has no session); returns the row's own phone and
--      its store's display name, nothing about any other row.
CREATE OR REPLACE FUNCTION public.ebda_sms_consent_lookup(p_id text)
RETURNS TABLE (id text, store_id text, phone text, granted boolean, store_name text, store_name_ar text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
  SELECT c.id, c.store_id, c.phone, c.granted, s.name, s.name_ar
  FROM public.sms_marketing_consents c
  JOIN public.stores s ON s.id = c.store_id
  WHERE c.id = p_id
$fn$;

-- 5.13 plans engine (SP5). The super-admin Plans page counts stores per plan and
--      the plan editor busts the feature cache of every store on a plan: both are
--      cross-store reads of store_subscriptions, so definers. GUARDED: an ACTIVE
--      super_admin only (SQLSTATE 42501 otherwise). They return a count per plan
--      and store ids, never subscription rows.
CREATE OR REPLACE FUNCTION public.ebda_plan_subscriber_counts()
RETURNS TABLE (plan_code text, n bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
BEGIN
  IF NOT public.ebda_is_super_admin() THEN
    RAISE EXCEPTION 'ebda_plan_subscriber_counts: caller is not a super_admin' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
    SELECT ss.plan_code, count(*) FROM public.store_subscriptions ss GROUP BY ss.plan_code;
END
$fn$;

CREATE OR REPLACE FUNCTION public.ebda_plan_store_ids(p_code text)
RETURNS TABLE (store_id text)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
BEGIN
  IF NOT public.ebda_is_super_admin() THEN
    RAISE EXCEPTION 'ebda_plan_store_ids: caller is not a super_admin' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
    SELECT ss.store_id FROM public.store_subscriptions ss WHERE ss.plan_code = p_code;
END
$fn$;

-- ---------------------------------------------------------------------------
-- 6. Function privileges: nobody but ebda_app.
-- ---------------------------------------------------------------------------
DO $priv$
DECLARE
  f RECORD;
BEGIN
  FOR f IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname LIKE 'ebda\_%'
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO ebda_app', f.sig);
  END LOOP;
END
$priv$;
