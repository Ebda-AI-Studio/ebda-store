-- Enable Row Level Security on tenant-scoped tables
-- This migration adds RLS policies for multi-tenant data isolation

-- ==========================================
-- Enable RLS on all tenant-scoped tables
-- ==========================================

ALTER TABLE stores ENABLE ROW LEVEL SECURITY;
ALTER TABLE products ENABLE ROW LEVEL SECURITY;
ALTER TABLE categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE carts ENABLE ROW LEVEL SECURITY;
ALTER TABLE cart_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE coupons ENABLE ROW LEVEL SECURITY;
ALTER TABLE shipping_zones ENABLE ROW LEVEL SECURITY;
ALTER TABLE tax_rates ENABLE ROW LEVEL SECURITY;
ALTER TABLE reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE wishlists ENABLE ROW LEVEL SECURITY;
ALTER TABLE newsletter_subscribers ENABLE ROW LEVEL SECURITY;
ALTER TABLE loyalty_points ENABLE ROW LEVEL SECURITY;
ALTER TABLE loyalty_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE returns ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_configs ENABLE ROW LEVEL SECURITY;

-- ==========================================
-- Create RLS Policies for Store Access
-- ==========================================

-- Stores: Owner can manage, super_admin can access all
CREATE POLICY "store_owner_access" ON stores
  FOR ALL
  USING (
    owner_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM users
      WHERE users.id = auth.uid()
      AND users.role = 'super_admin'
    )
  );

-- Products: Store owner can manage their store's products
CREATE POLICY "product_store_access" ON products
  FOR ALL
  USING (
    store_id IN (
      SELECT id FROM stores
      WHERE owner_id = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM users
      WHERE users.id = auth.uid()
      AND users.role = 'super_admin'
    )
  );

-- Categories: Store owner can manage their store's categories
CREATE POLICY "category_store_access" ON categories
  FOR ALL
  USING (
    store_id IN (
      SELECT id FROM stores
      WHERE owner_id = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM users
      WHERE users.id = auth.uid()
      AND users.role = 'super_admin'
    )
  );

-- Orders: Store owner can view/manage their store's orders
CREATE POLICY "order_store_access" ON orders
  FOR ALL
  USING (
    store_id IN (
      SELECT id FROM stores
      WHERE owner_id = auth.uid()
    )
    OR customer_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM users
      WHERE users.id = auth.uid()
      AND users.role = 'super_admin'
    )
  );

-- Customers: Store owner can view their store's customers
CREATE POLICY "customer_store_access" ON customers
  FOR ALL
  USING (
    store_id IN (
      SELECT id FROM stores
      WHERE owner_id = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM users
      WHERE users.id = auth.uid()
      AND users.role = 'super_admin'
    )
  );

-- Carts: Store owner can view, customers can manage their own
CREATE POLICY "cart_access" ON carts
  FOR ALL
  USING (
    customer_id = auth.uid()
    OR store_id IN (
      SELECT id FROM stores
      WHERE owner_id = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM users
      WHERE users.id = auth.uid()
      AND users.role = 'super_admin'
    )
  );

-- Tags: Store owner can manage their store's tags
CREATE POLICY "tag_store_access" ON tags
  FOR ALL
  USING (
    store_id IN (
      SELECT id FROM stores
      WHERE owner_id = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM users
      WHERE users.id = auth.uid()
      AND users.role = 'super_admin'
    )
  );

-- Coupons: Store owner can manage their store's coupons
CREATE POLICY "coupon_store_access" ON coupons
  FOR ALL
  USING (
    store_id IN (
      SELECT id FROM stores
      WHERE owner_id = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM users
      WHERE users.id = auth.uid()
      AND users.role = 'super_admin'
    )
  );

-- Shipping Zones: Store owner can manage their store's shipping zones
CREATE POLICY "shipping_zone_store_access" ON shipping_zones
  FOR ALL
  USING (
    store_id IN (
      SELECT id FROM stores
      WHERE owner_id = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM users
      WHERE users.id = auth.uid()
      AND users.role = 'super_admin'
    )
  );

-- Tax Rates: Store owner can manage their store's tax rates
CREATE POLICY "tax_rate_store_access" ON tax_rates
  FOR ALL
  USING (
    store_id IN (
      SELECT id FROM stores
      WHERE owner_id = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM users
      WHERE users.id = auth.uid()
      AND users.role = 'super_admin'
    )
  );

-- Reviews: Store owner can view, customers can manage their own
CREATE POLICY "review_access" ON reviews
  FOR ALL
  USING (
    customer_id = auth.uid()
    OR store_id IN (
      SELECT id FROM stores
      WHERE owner_id = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM users
      WHERE users.id = auth.uid()
      AND users.role = 'super_admin'
    )
  );

-- Wishlists: Users can manage their own wishlists
CREATE POLICY "wishlist_access" ON wishlists
  FOR ALL
  USING (
    user_id = auth.uid()
    OR store_id IN (
      SELECT id FROM stores
      WHERE owner_id = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM users
      WHERE users.id = auth.uid()
      AND users.role = 'super_admin'
    )
  );

-- Newsletter Subscribers: Store owner can manage
CREATE POLICY "newsletter_store_access" ON newsletter_subscribers
  FOR ALL
  USING (
    store_id IN (
      SELECT id FROM stores
      WHERE owner_id = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM users
      WHERE users.id = auth.uid()
      AND users.role = 'super_admin'
    )
  );

-- Loyalty Points: Store owner can view, customers can view their own
CREATE POLICY "loyalty_points_access" ON loyalty_points
  FOR ALL
  USING (
    customer_id = auth.uid()
    OR store_id IN (
      SELECT id FROM stores
      WHERE owner_id = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM users
      WHERE users.id = auth.uid()
      AND users.role = 'super_admin'
    )
  );

-- Loyalty Transactions: Store owner can view, customers can view their own
CREATE POLICY "loyalty_transactions_access" ON loyalty_transactions
  FOR ALL
  USING (
    customer_id = auth.uid()
    OR store_id IN (
      SELECT id FROM stores
      WHERE owner_id = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM users
      WHERE users.id = auth.uid()
      AND users.role = 'super_admin'
    )
  );

-- Returns: Store owner can manage, customers can view their own
CREATE POLICY "return_access" ON returns
  FOR ALL
  USING (
    customer_id = auth.uid()
    OR store_id IN (
      SELECT id FROM stores
      WHERE owner_id = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM users
      WHERE users.id = auth.uid()
      AND users.role = 'super_admin'
    )
  );

-- Inventory History: Store owner can view
CREATE POLICY "inventory_history_store_access" ON inventory_history
  FOR ALL
  USING (
    store_id IN (
      SELECT id FROM stores
      WHERE owner_id = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM users
      WHERE users.id = auth.uid()
      AND users.role = 'super_admin'
    )
  );

-- Payment Configs: Store owner can manage their store's configs, super_admin can manage all
CREATE POLICY "payment_config_access" ON payment_configs
  FOR ALL
  USING (
    store_id IS NULL -- Global configs only for super_admin
    OR store_id IN (
      SELECT id FROM stores
      WHERE owner_id = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM users
      WHERE users.id = auth.uid()
      AND users.role = 'super_admin'
    )
  );

-- ==========================================
-- Public Read Access for Storefront
-- ==========================================

-- Allow public read access to active products
CREATE POLICY "public_product_read" ON products
  FOR SELECT
  USING (status = 'active');

-- Allow public read access to active categories
CREATE POLICY "public_category_read" ON categories
  FOR SELECT
  USING (is_active = true);

-- Allow public read access to approved reviews
CREATE POLICY "public_review_read" ON reviews
  FOR SELECT
  USING (is_approved = true);

-- Allow public read access to active stores
CREATE POLICY "public_store_read" ON stores
  FOR SELECT
  USING (status = 'active');

-- Allow public read access to active coupons (for validation)
CREATE POLICY "public_coupon_read" ON coupons
  FOR SELECT
  USING (is_active = true);

-- Allow public read access to active shipping zones
CREATE POLICY "public_shipping_zone_read" ON shipping_zones
  FOR SELECT
  USING (is_active = true);
