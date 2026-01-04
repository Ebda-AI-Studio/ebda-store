-- Performance Indexes Migration
-- Adds indexes for common query patterns to improve performance at scale

-- ==========================================
-- Product Indexes
-- ==========================================

-- Product search by store and name/slug
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_products_store_id" ON "Product"("storeId");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_products_slug" ON "Product"("slug");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_products_sku" ON "Product"("sku");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_products_status" ON "Product"("status");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_products_store_status" ON "Product"("storeId", "status");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_products_category" ON "Product"("categoryId");

-- Product text search (for product name searches)
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_products_name_gin" ON "Product" USING gin(to_tsvector('english', "name"));

-- ==========================================
-- Order Indexes
-- ==========================================

-- Order lookup patterns
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_orders_store_id" ON "Order"("storeId");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_orders_customer_id" ON "Order"("customerId");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_orders_order_number" ON "Order"("orderNumber");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_orders_status" ON "Order"("status");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_orders_payment_status" ON "Order"("paymentStatus");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_orders_created_at" ON "Order"("createdAt" DESC);
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_orders_store_status" ON "Order"("storeId", "status");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_orders_idempotency" ON "Order"("idempotencyKey") WHERE "idempotencyKey" IS NOT NULL;

-- ==========================================
-- User Indexes
-- ==========================================

CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_users_role" ON "User"("role");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_users_created_at" ON "User"("createdAt" DESC);

-- ==========================================
-- Store Indexes
-- ==========================================

CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_stores_owner_id" ON "Store"("ownerId");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_stores_slug" ON "Store"("slug");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_stores_domain" ON "Store"("domain") WHERE "domain" IS NOT NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_stores_status" ON "Store"("status");

-- ==========================================
-- Category Indexes
-- ==========================================

CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_categories_store_id" ON "Category"("storeId");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_categories_parent_id" ON "Category"("parentId");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_categories_slug" ON "Category"("slug");

-- ==========================================
-- Payment Indexes
-- ==========================================

CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_payments_order_id" ON "Payment"("orderId");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_payments_transaction_id" ON "Payment"("transactionId");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_payments_status" ON "Payment"("status");

-- ==========================================
-- Audit Log Indexes
-- ==========================================

CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_audit_logs_user_id" ON "AuditLog"("userId");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_audit_logs_resource" ON "AuditLog"("resourceType", "resourceId");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_audit_logs_action" ON "AuditLog"("action");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_audit_logs_created_at" ON "AuditLog"("createdAt" DESC);

-- ==========================================
-- Token Indexes
-- ==========================================

CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_refresh_tokens_user_id" ON "RefreshToken"("userId");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_refresh_tokens_expires" ON "RefreshToken"("expiresAt");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_verification_tokens_user" ON "VerificationToken"("userId", "type");

-- ==========================================
-- Cart Indexes
-- ==========================================

CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_carts_store_id" ON "Cart"("storeId");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_carts_user_id" ON "Cart"("userId") WHERE "userId" IS NOT NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_carts_session_id" ON "Cart"("sessionId") WHERE "sessionId" IS NOT NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_cart_items_cart_id" ON "CartItem"("cartId");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_cart_items_product" ON "CartItem"("productId");

-- ==========================================
-- Review Indexes
-- ==========================================

CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_reviews_product_id" ON "Review"("productId");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_reviews_user_id" ON "Review"("userId");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_reviews_store_id" ON "Review"("storeId");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_reviews_status" ON "Review"("status");

-- ==========================================
-- Tag Indexes
-- ==========================================

CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_tags_store_id" ON "Tag"("storeId");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_product_tags_product" ON "ProductTag"("productId");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_product_tags_tag" ON "ProductTag"("tagId");

-- ==========================================
-- Return Indexes
-- ==========================================

CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_returns_order_id" ON "Return"("orderId");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_returns_store_id" ON "Return"("storeId");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_returns_status" ON "Return"("status");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_returns_return_number" ON "Return"("returnNumber");

-- ==========================================
-- Coupon Indexes
-- ==========================================

CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_coupons_store_id" ON "Coupon"("storeId");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_coupons_code" ON "Coupon"("code");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_coupons_active" ON "Coupon"("isActive", "validFrom", "validUntil");
