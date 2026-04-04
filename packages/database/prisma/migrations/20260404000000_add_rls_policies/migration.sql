-- Row-Level Security (RLS) for Multi-Tenant Isolation
--
-- This migration adds RLS policies to all tenant-scoped tables so that
-- even if application code misses a WHERE store_id = ? filter, the database
-- enforces isolation.
--
-- How it works:
-- 1. The API sets `app.current_store_id` via SET LOCAL at the start of each transaction
-- 2. RLS policies check current_setting('app.current_store_id', true) on SELECT/INSERT/UPDATE/DELETE
-- 3. A separate `force_app` role is created for the API connection (non-owner, so RLS applies)
-- 4. The migration/owner role bypasses RLS for admin operations

-- Step 1: Create the application role (non-superuser, so RLS applies)
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'force_app') THEN
    CREATE ROLE force_app LOGIN;
  END IF;
END
$$;

-- Grant necessary permissions to force_app
GRANT USAGE ON SCHEMA public TO force_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO force_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO force_app;

-- Ensure future tables also get permissions
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO force_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO force_app;

-- Step 2: Enable RLS on all tenant-scoped tables
-- Tables with required store_id (NOT NULL)
ALTER TABLE customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE products ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE carts ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE returns ENABLE ROW LEVEL SECURITY;
ALTER TABLE store_features ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_event_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE push_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE abandoned_carts ENABLE ROW LEVEL SECURITY;
ALTER TABLE abandoned_cart_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_relations ENABLE ROW LEVEL SECURITY;
ALTER TABLE frequently_bought_together ENABLE ROW LEVEL SECURITY;
ALTER TABLE shipping_carrier_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE shipments ENABLE ROW LEVEL SECURITY;
ALTER TABLE affiliates ENABLE ROW LEVEL SECURITY;
ALTER TABLE affiliate_referrals ENABLE ROW LEVEL SECURITY;
ALTER TABLE affiliate_payouts ENABLE ROW LEVEL SECURITY;
ALTER TABLE affiliate_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE wishlists ENABLE ROW LEVEL SECURITY;
ALTER TABLE coupons ENABLE ROW LEVEL SECURITY;
ALTER TABLE shipping_zones ENABLE ROW LEVEL SECURITY;
ALTER TABLE tax_rates ENABLE ROW LEVEL SECURITY;
ALTER TABLE loyalty_points ENABLE ROW LEVEL SECURITY;
ALTER TABLE loyalty_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE newsletter_subscribers ENABLE ROW LEVEL SECURITY;
ALTER TABLE reviews ENABLE ROW LEVEL SECURITY;

-- Tables with optional store_id (nullable) — separate policies
ALTER TABLE payment_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;

-- Step 3: Create RLS policies for required store_id tables
-- Pattern: allow access when store_id matches the session variable
-- If no session variable is set (super_admin / migration context), allow all

CREATE OR REPLACE FUNCTION current_store_id() RETURNS TEXT AS $$
BEGIN
  RETURN NULLIF(current_setting('app.current_store_id', true), '');
EXCEPTION
  WHEN OTHERS THEN RETURN NULL;
END;
$$ LANGUAGE plpgsql STABLE;

-- Macro to avoid repeating the same policy for 30+ tables
-- We create one SELECT policy and one modification policy per table

DO $$
DECLARE
  tbl TEXT;
  tables TEXT[] := ARRAY[
    'customers', 'categories', 'products', 'inventory_history', 'tags',
    'carts', 'orders', 'returns', 'store_features',
    'notification_configs', 'notification_event_configs', 'push_subscriptions',
    'notification_logs', 'abandoned_carts', 'abandoned_cart_configs',
    'product_relations', 'frequently_bought_together',
    'shipping_carrier_configs', 'shipments',
    'affiliates', 'affiliate_referrals', 'affiliate_payouts', 'affiliate_configs',
    'wishlists', 'coupons', 'shipping_zones', 'tax_rates',
    'loyalty_points', 'loyalty_transactions', 'newsletter_subscribers', 'reviews'
  ];
BEGIN
  FOREACH tbl IN ARRAY tables
  LOOP
    -- Allow all access when no store context is set (super_admin, migrations)
    -- Restrict to matching store_id when context IS set
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR ALL TO force_app USING (
        current_store_id() IS NULL OR store_id = current_store_id()
      ) WITH CHECK (
        current_store_id() IS NULL OR store_id = current_store_id()
      )',
      'rls_' || tbl || '_tenant',
      tbl
    );
  END LOOP;
END
$$;

-- Step 4: Policies for tables with optional/nullable store_id

-- payment_configs: store_id can be NULL (global defaults)
CREATE POLICY rls_payment_configs_tenant ON payment_configs
  FOR ALL TO force_app
  USING (
    current_store_id() IS NULL
    OR store_id IS NULL
    OR store_id = current_store_id()
  )
  WITH CHECK (
    current_store_id() IS NULL
    OR store_id IS NULL
    OR store_id = current_store_id()
  );

-- audit_logs: store_id can be NULL (system-level events)
CREATE POLICY rls_audit_logs_tenant ON audit_logs
  FOR ALL TO force_app
  USING (
    current_store_id() IS NULL
    OR store_id IS NULL
    OR store_id = current_store_id()
  )
  WITH CHECK (
    current_store_id() IS NULL
    OR store_id IS NULL
    OR store_id = current_store_id()
  );

-- Step 5: Tables without store_id (global) — no RLS needed
-- users, refresh_tokens, verification_tokens, stores, product_images,
-- product_categories, product_tags, product_options, product_option_values,
-- product_variants, product_variant_options, cart_items, order_items,
-- payments, return_items, system_settings, addresses, wishlist_items
-- These are either global or access-controlled via their parent's store_id.
