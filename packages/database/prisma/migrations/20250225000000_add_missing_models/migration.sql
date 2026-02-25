-- Force Website Builder - Add Missing Models Migration
-- Adds all models, enums, columns, and indexes missing from initial migration

-- ==========================================
-- Missing Enum Types
-- ==========================================

-- UserRole: add missing 'store_admin' value (initial had 'admin' instead)
-- Note: We need to handle enum value rename: 'admin' -> 'store_admin'
DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'admin' AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'UserRole')) THEN
        ALTER TYPE "UserRole" RENAME VALUE 'admin' TO 'store_admin';
    END IF;
END $$;

-- UserStatus enum (completely missing)
DO $$ BEGIN
    CREATE TYPE "UserStatus" AS ENUM ('active', 'inactive', 'suspended');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- StorePlan enum (completely missing)
DO $$ BEGIN
    CREATE TYPE "StorePlan" AS ENUM ('free', 'starter', 'professional', 'enterprise');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- StoreTemplate enum (completely missing)
DO $$ BEGIN
    CREATE TYPE "StoreTemplate" AS ENUM ('modern', 'classic', 'minimal', 'bold', 'elegant');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- VerificationTokenType enum (completely missing)
DO $$ BEGIN
    CREATE TYPE "VerificationTokenType" AS ENUM ('email', 'password_reset', 'two_factor');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- PaymentProvider enum (completely missing)
DO $$ BEGIN
    CREATE TYPE "PaymentProvider" AS ENUM ('tap', 'myfatoorah', 'hesabe', 'upayments');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ProviderHealthStatus enum (completely missing)
DO $$ BEGIN
    CREATE TYPE "ProviderHealthStatus" AS ENUM ('healthy', 'degraded', 'down', 'unknown');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- CouponType enum (completely missing)
DO $$ BEGIN
    CREATE TYPE "CouponType" AS ENUM ('percentage', 'fixed', 'free_shipping');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- InventoryChangeType enum (completely missing)
DO $$ BEGIN
    CREATE TYPE "InventoryChangeType" AS ENUM ('manual_add', 'manual_remove', 'sale', 'return_stock', 'adjustment', 'damage', 'transfer_in', 'transfer_out', 'initial');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ReturnType enum (completely missing)
DO $$ BEGIN
    CREATE TYPE "ReturnType" AS ENUM ('return', 'exchange', 'refund');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ReturnStatus enum (completely missing)
DO $$ BEGIN
    CREATE TYPE "ReturnStatus" AS ENUM ('pending', 'approved', 'rejected', 'shipped', 'received', 'inspecting', 'completed', 'cancelled');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- LoyaltyTransactionType enum (completely missing)
DO $$ BEGIN
    CREATE TYPE "LoyaltyTransactionType" AS ENUM ('earn_purchase', 'earn_signup', 'earn_referral', 'earn_review', 'earn_birthday', 'earn_manual', 'redeem_discount', 'redeem_product', 'expire', 'adjust');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- PaymentStatus: add missing values
DO $$ BEGIN
    ALTER TYPE "PaymentStatus" ADD VALUE IF NOT EXISTS 'cancelled';
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TYPE "PaymentStatus" ADD VALUE IF NOT EXISTS 'expired';
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ==========================================
-- Missing Columns on Existing Tables
-- ==========================================

-- users: add missing columns
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "phone" TEXT;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "status" "UserStatus" NOT NULL DEFAULT 'active';
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "language" TEXT NOT NULL DEFAULT 'en';
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "last_login_at" TIMESTAMP(3);
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "deleted_at" TIMESTAMP(3);

-- Drop stripe_customer_id column if it exists (not in schema)
ALTER TABLE "users" DROP COLUMN IF EXISTS "stripe_customer_id";

-- stores: add many missing columns
ALTER TABLE "stores" ADD COLUMN IF NOT EXISTS "name_ar" TEXT;
ALTER TABLE "stores" ADD COLUMN IF NOT EXISTS "logo_ar" TEXT;
ALTER TABLE "stores" ADD COLUMN IF NOT EXISTS "description" TEXT;
ALTER TABLE "stores" ADD COLUMN IF NOT EXISTS "description_ar" TEXT;
ALTER TABLE "stores" ADD COLUMN IF NOT EXISTS "currency" TEXT NOT NULL DEFAULT 'KWD';
ALTER TABLE "stores" ADD COLUMN IF NOT EXISTS "timezone" TEXT NOT NULL DEFAULT 'Asia/Kuwait';
ALTER TABLE "stores" ADD COLUMN IF NOT EXISTS "deleted_at" TIMESTAMP(3);
ALTER TABLE "stores" ADD COLUMN IF NOT EXISTS "template" "StoreTemplate" NOT NULL DEFAULT 'modern';
ALTER TABLE "stores" ADD COLUMN IF NOT EXISTS "theme" JSONB NOT NULL DEFAULT '{}';
ALTER TABLE "stores" ADD COLUMN IF NOT EXISTS "social_links" JSONB NOT NULL DEFAULT '{}';
ALTER TABLE "stores" ADD COLUMN IF NOT EXISTS "email" TEXT;
ALTER TABLE "stores" ADD COLUMN IF NOT EXISTS "phone" TEXT;
ALTER TABLE "stores" ADD COLUMN IF NOT EXISTS "phone_ar" TEXT;
ALTER TABLE "stores" ADD COLUMN IF NOT EXISTS "whatsapp" TEXT;
ALTER TABLE "stores" ADD COLUMN IF NOT EXISTS "address" TEXT;
ALTER TABLE "stores" ADD COLUMN IF NOT EXISTS "address_ar" TEXT;
ALTER TABLE "stores" ADD COLUMN IF NOT EXISTS "announcement_bar" JSONB;
ALTER TABLE "stores" ADD COLUMN IF NOT EXISTS "meta_title" TEXT;
ALTER TABLE "stores" ADD COLUMN IF NOT EXISTS "meta_title_ar" TEXT;
ALTER TABLE "stores" ADD COLUMN IF NOT EXISTS "meta_description" TEXT;
ALTER TABLE "stores" ADD COLUMN IF NOT EXISTS "meta_description_ar" TEXT;
ALTER TABLE "stores" ADD COLUMN IF NOT EXISTS "marketing_pixels" JSONB NOT NULL DEFAULT '{}';
ALTER TABLE "stores" ADD COLUMN IF NOT EXISTS "meta_pixel_id" TEXT;
ALTER TABLE "stores" ADD COLUMN IF NOT EXISTS "tiktok_pixel_id" TEXT;
ALTER TABLE "stores" ADD COLUMN IF NOT EXISTS "snapchat_pixel_id" TEXT;
ALTER TABLE "stores" ADD COLUMN IF NOT EXISTS "google_analytics_id" TEXT;
ALTER TABLE "stores" ADD COLUMN IF NOT EXISTS "google_tag_manager_id" TEXT;
ALTER TABLE "stores" ADD COLUMN IF NOT EXISTS "google_ads_id" TEXT;
ALTER TABLE "stores" ADD COLUMN IF NOT EXISTS "twitter_pixel_id" TEXT;
ALTER TABLE "stores" ADD COLUMN IF NOT EXISTS "pinterest_tag_id" TEXT;
ALTER TABLE "stores" ADD COLUMN IF NOT EXISTS "tax_enabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "stores" ADD COLUMN IF NOT EXISTS "tax_included_in_price" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "stores" ADD COLUMN IF NOT EXISTS "default_tax_rate" DECIMAL(5,2);
ALTER TABLE "stores" ADD COLUMN IF NOT EXISTS "loyalty_enabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "stores" ADD COLUMN IF NOT EXISTS "loyalty_settings" JSONB NOT NULL DEFAULT '{}';
ALTER TABLE "stores" ADD COLUMN IF NOT EXISTS "pwa_enabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "stores" ADD COLUMN IF NOT EXISTS "pwa_settings" JSONB NOT NULL DEFAULT '{}';
ALTER TABLE "stores" ADD COLUMN IF NOT EXISTS "plan" "StorePlan" NOT NULL DEFAULT 'starter';

-- categories: add missing columns
ALTER TABLE "categories" ADD COLUMN IF NOT EXISTS "name_ar" TEXT;
ALTER TABLE "categories" ADD COLUMN IF NOT EXISTS "description_ar" TEXT;
ALTER TABLE "categories" ADD COLUMN IF NOT EXISTS "is_active" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "categories" ADD COLUMN IF NOT EXISTS "deleted_at" TIMESTAMP(3);

-- products: add missing columns
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "name_ar" TEXT;
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "description_ar" TEXT;
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "low_stock_threshold" INTEGER NOT NULL DEFAULT 5;
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "dimensions" JSONB;
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "is_new" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "view_count" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "meta_title_ar" TEXT;
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "meta_description_ar" TEXT;
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "deleted_at" TIMESTAMP(3);
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "has_variants" BOOLEAN NOT NULL DEFAULT false;

-- cart_items: add missing variant_id column
ALTER TABLE "cart_items" ADD COLUMN IF NOT EXISTS "variant_id" TEXT;

-- orders: add missing columns
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "coupon_code" TEXT;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "coupon_discount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "customer_notes" TEXT;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "shipped_at" TIMESTAMP(3);
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "delivered_at" TIMESTAMP(3);
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "deleted_at" TIMESTAMP(3);
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "idempotency_key" TEXT;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "webhook_processed_at" TIMESTAMP(3);

-- Update orders default currency from USD to KWD
ALTER TABLE "orders" ALTER COLUMN "currency" SET DEFAULT 'KWD';

-- order_items: add missing columns
ALTER TABLE "order_items" ADD COLUMN IF NOT EXISTS "variant_id" TEXT;
ALTER TABLE "order_items" ADD COLUMN IF NOT EXISTS "variant_name" TEXT;

-- payments: add missing columns and restructure
ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "provider" TEXT NOT NULL DEFAULT 'tap';
ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "invoice_id" TEXT;
ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "payment_url" TEXT;
ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "refund_id" TEXT;

-- Update payments default currency from USD to KWD
ALTER TABLE "payments" ALTER COLUMN "currency" SET DEFAULT 'KWD';

-- Make payments.method nullable (schema says method is String?)
ALTER TABLE "payments" ALTER COLUMN "method" DROP NOT NULL;
ALTER TABLE "payments" ALTER COLUMN "method" DROP DEFAULT;

-- audit_logs: add missing store_id column
ALTER TABLE "audit_logs" ADD COLUMN IF NOT EXISTS "store_id" TEXT;

-- addresses: add missing columns
ALTER TABLE "addresses" ADD COLUMN IF NOT EXISTS "area" TEXT;
ALTER TABLE "addresses" ADD COLUMN IF NOT EXISTS "block" TEXT;
ALTER TABLE "addresses" ADD COLUMN IF NOT EXISTS "street" TEXT;
ALTER TABLE "addresses" ADD COLUMN IF NOT EXISTS "building" TEXT;
ALTER TABLE "addresses" ADD COLUMN IF NOT EXISTS "floor" TEXT;
ALTER TABLE "addresses" ADD COLUMN IF NOT EXISTS "apartment" TEXT;

-- Make addresses.postal_code nullable (schema says String?)
ALTER TABLE "addresses" ALTER COLUMN "postal_code" DROP NOT NULL;

-- Update addresses default country
ALTER TABLE "addresses" ALTER COLUMN "country" SET DEFAULT 'Kuwait';

-- tags: add missing store_id column
ALTER TABLE "tags" ADD COLUMN IF NOT EXISTS "store_id" TEXT;

-- ==========================================
-- Missing Tables
-- ==========================================

-- verification_tokens
CREATE TABLE IF NOT EXISTS "verification_tokens" (
    "id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "type" "VerificationTokenType" NOT NULL DEFAULT 'email',
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "verification_tokens_pkey" PRIMARY KEY ("id")
);

-- customers
CREATE TABLE IF NOT EXISTS "customers" (
    "id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "first_name" TEXT NOT NULL,
    "last_name" TEXT NOT NULL,
    "phone" TEXT,
    "notes" TEXT,
    "total_orders" INTEGER NOT NULL DEFAULT 0,
    "total_spent" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customers_pkey" PRIMARY KEY ("id")
);

-- product_options
CREATE TABLE IF NOT EXISTS "product_options" (
    "id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "name_ar" TEXT,
    "position" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_options_pkey" PRIMARY KEY ("id")
);

-- product_option_values
CREATE TABLE IF NOT EXISTS "product_option_values" (
    "id" TEXT NOT NULL,
    "option_id" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "value_ar" TEXT,
    "position" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_option_values_pkey" PRIMARY KEY ("id")
);

-- product_variants
CREATE TABLE IF NOT EXISTS "product_variants" (
    "id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "title_ar" TEXT,
    "sku" TEXT,
    "barcode" TEXT,
    "price" INTEGER,
    "compare_at_price" INTEGER,
    "cost_price" INTEGER,
    "inventory" INTEGER NOT NULL DEFAULT 0,
    "weight" DOUBLE PRECISION,
    "image_url" TEXT,
    "position" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "product_variants_pkey" PRIMARY KEY ("id")
);

-- product_variant_options
CREATE TABLE IF NOT EXISTS "product_variant_options" (
    "variant_id" TEXT NOT NULL,
    "value_id" TEXT NOT NULL,

    CONSTRAINT "product_variant_options_pkey" PRIMARY KEY ("variant_id","value_id")
);

-- inventory_history
CREATE TABLE IF NOT EXISTS "inventory_history" (
    "id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "type" "InventoryChangeType" NOT NULL,
    "quantity" INTEGER NOT NULL,
    "previous_stock" INTEGER NOT NULL,
    "new_stock" INTEGER NOT NULL,
    "reason" TEXT,
    "reference" TEXT,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inventory_history_pkey" PRIMARY KEY ("id")
);

-- payment_configs
CREATE TABLE IF NOT EXISTS "payment_configs" (
    "id" TEXT NOT NULL,
    "store_id" TEXT,
    "provider" "PaymentProvider" NOT NULL,
    "is_enabled" BOOLEAN NOT NULL DEFAULT false,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "display_name" TEXT,
    "display_name_ar" TEXT,
    "api_key" TEXT,
    "secret_key" TEXT,
    "merchant_id" TEXT,
    "webhook_secret" TEXT,
    "test_mode" BOOLEAN NOT NULL DEFAULT true,
    "supported_methods" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "supported_currencies" TEXT[] DEFAULT ARRAY['KWD']::TEXT[],
    "fixed_fee" INTEGER NOT NULL DEFAULT 0,
    "percentage_fee" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "last_health_check" TIMESTAMP(3),
    "health_status" "ProviderHealthStatus" NOT NULL DEFAULT 'unknown',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" TEXT,
    "updated_by" TEXT,

    CONSTRAINT "payment_configs_pkey" PRIMARY KEY ("id")
);

-- system_settings
CREATE TABLE IF NOT EXISTS "system_settings" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "category" TEXT NOT NULL DEFAULT 'general',
    "is_public" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "system_settings_pkey" PRIMARY KEY ("id")
);

-- coupons
CREATE TABLE IF NOT EXISTS "coupons" (
    "id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "name_ar" TEXT,
    "description" TEXT,
    "description_ar" TEXT,
    "type" "CouponType" NOT NULL DEFAULT 'percentage',
    "value" INTEGER NOT NULL,
    "min_order_amount" INTEGER,
    "max_discount" INTEGER,
    "usage_limit" INTEGER,
    "usage_count" INTEGER NOT NULL DEFAULT 0,
    "usage_limit_per_user" INTEGER,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "starts_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "coupons_pkey" PRIMARY KEY ("id")
);

-- shipping_zones
CREATE TABLE IF NOT EXISTS "shipping_zones" (
    "id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "name_ar" TEXT,
    "areas" JSONB NOT NULL DEFAULT '[]',
    "areas_ar" JSONB NOT NULL DEFAULT '[]',
    "delivery_fee" INTEGER NOT NULL DEFAULT 0,
    "free_shipping_threshold" INTEGER,
    "estimated_days" INTEGER,
    "estimated_days_min" INTEGER,
    "estimated_days_max" INTEGER,
    "position" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shipping_zones_pkey" PRIMARY KEY ("id")
);

-- tax_rates
CREATE TABLE IF NOT EXISTS "tax_rates" (
    "id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "name_ar" TEXT,
    "rate" DECIMAL(5,2) NOT NULL,
    "country" TEXT,
    "state" TEXT,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "is_compound" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tax_rates_pkey" PRIMARY KEY ("id")
);

-- wishlists
CREATE TABLE IF NOT EXISTS "wishlists" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT 'My Wishlist',
    "is_public" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "wishlists_pkey" PRIMARY KEY ("id")
);

-- wishlist_items
CREATE TABLE IF NOT EXISTS "wishlist_items" (
    "id" TEXT NOT NULL,
    "wishlist_id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "added_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wishlist_items_pkey" PRIMARY KEY ("id")
);

-- newsletter_subscribers
CREATE TABLE IF NOT EXISTS "newsletter_subscribers" (
    "id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "first_name" TEXT,
    "last_name" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "subscribed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "unsubscribed_at" TIMESTAMP(3),

    CONSTRAINT "newsletter_subscribers_pkey" PRIMARY KEY ("id")
);

-- reviews
CREATE TABLE IF NOT EXISTS "reviews" (
    "id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "customer_id" TEXT,
    "order_id" TEXT,
    "rating" INTEGER NOT NULL,
    "title" TEXT,
    "comment" TEXT,
    "is_verified" BOOLEAN NOT NULL DEFAULT false,
    "is_approved" BOOLEAN NOT NULL DEFAULT false,
    "helpful_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reviews_pkey" PRIMARY KEY ("id")
);

-- returns
CREATE TABLE IF NOT EXISTS "returns" (
    "id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "return_number" TEXT NOT NULL,
    "type" "ReturnType" NOT NULL DEFAULT 'return',
    "status" "ReturnStatus" NOT NULL DEFAULT 'pending',
    "reason" TEXT NOT NULL,
    "reason_detail" TEXT,
    "refund_amount" INTEGER NOT NULL DEFAULT 0,
    "refund_method" TEXT,
    "refunded_at" TIMESTAMP(3),
    "tracking_number" TEXT,
    "shipped_at" TIMESTAMP(3),
    "received_at" TIMESTAMP(3),
    "approved_by" TEXT,
    "approved_at" TIMESTAMP(3),
    "rejected_by" TEXT,
    "rejected_at" TIMESTAMP(3),
    "rejection_reason" TEXT,
    "admin_notes" TEXT,
    "customer_notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "returns_pkey" PRIMARY KEY ("id")
);

-- return_items
CREATE TABLE IF NOT EXISTS "return_items" (
    "id" TEXT NOT NULL,
    "return_id" TEXT NOT NULL,
    "order_item_id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "product_name" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "reason" TEXT,
    "condition" TEXT,

    CONSTRAINT "return_items_pkey" PRIMARY KEY ("id")
);

-- loyalty_points
CREATE TABLE IF NOT EXISTS "loyalty_points" (
    "id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "points" INTEGER NOT NULL DEFAULT 0,
    "total_earned" INTEGER NOT NULL DEFAULT 0,
    "total_redeemed" INTEGER NOT NULL DEFAULT 0,
    "tier" TEXT NOT NULL DEFAULT 'bronze',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "loyalty_points_pkey" PRIMARY KEY ("id")
);

-- loyalty_transactions
CREATE TABLE IF NOT EXISTS "loyalty_transactions" (
    "id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "order_id" TEXT,
    "type" "LoyaltyTransactionType" NOT NULL,
    "points" INTEGER NOT NULL,
    "description" TEXT,
    "expires_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "loyalty_transactions_pkey" PRIMARY KEY ("id")
);

-- ==========================================
-- Unique Constraints on New Tables
-- ==========================================

CREATE UNIQUE INDEX IF NOT EXISTS "verification_tokens_token_key" ON "verification_tokens"("token");
CREATE UNIQUE INDEX IF NOT EXISTS "customers_store_id_email_key" ON "customers"("store_id", "email");
CREATE UNIQUE INDEX IF NOT EXISTS "product_options_product_id_name_key" ON "product_options"("product_id", "name");
CREATE UNIQUE INDEX IF NOT EXISTS "product_option_values_option_id_value_key" ON "product_option_values"("option_id", "value");
CREATE UNIQUE INDEX IF NOT EXISTS "payment_configs_store_id_provider_key" ON "payment_configs"("store_id", "provider");
CREATE UNIQUE INDEX IF NOT EXISTS "system_settings_key_key" ON "system_settings"("key");
CREATE UNIQUE INDEX IF NOT EXISTS "coupons_store_id_code_key" ON "coupons"("store_id", "code");
CREATE UNIQUE INDEX IF NOT EXISTS "wishlists_user_id_store_id_key" ON "wishlists"("user_id", "store_id");
CREATE UNIQUE INDEX IF NOT EXISTS "wishlist_items_wishlist_id_product_id_key" ON "wishlist_items"("wishlist_id", "product_id");
CREATE UNIQUE INDEX IF NOT EXISTS "newsletter_subscribers_store_id_email_key" ON "newsletter_subscribers"("store_id", "email");
CREATE UNIQUE INDEX IF NOT EXISTS "returns_return_number_key" ON "returns"("return_number");
CREATE UNIQUE INDEX IF NOT EXISTS "loyalty_points_store_id_customer_id_key" ON "loyalty_points"("store_id", "customer_id");
CREATE UNIQUE INDEX IF NOT EXISTS "orders_idempotency_key_key" ON "orders"("idempotency_key");

-- cart_items unique constraint update (now includes variant_id)
-- Drop old constraint and create new one
DROP INDEX IF EXISTS "cart_items_cart_id_product_id_key";
CREATE UNIQUE INDEX IF NOT EXISTS "cart_items_cart_id_product_id_variant_id_key" ON "cart_items"("cart_id", "product_id", "variant_id");

-- tags: drop old unique on name, add new unique on store_id+name
DROP INDEX IF EXISTS "tags_name_key";

-- ==========================================
-- Missing Indexes on Existing Tables
-- ==========================================

-- users indexes
CREATE INDEX IF NOT EXISTS "users_role_idx" ON "users"("role");
CREATE INDEX IF NOT EXISTS "users_status_idx" ON "users"("status");
CREATE INDEX IF NOT EXISTS "users_created_at_idx" ON "users"("created_at");

-- refresh_tokens indexes
CREATE INDEX IF NOT EXISTS "refresh_tokens_user_id_idx" ON "refresh_tokens"("user_id");
CREATE INDEX IF NOT EXISTS "refresh_tokens_expires_at_idx" ON "refresh_tokens"("expires_at");

-- stores indexes
CREATE INDEX IF NOT EXISTS "stores_owner_id_idx" ON "stores"("owner_id");
CREATE INDEX IF NOT EXISTS "stores_status_idx" ON "stores"("status");
CREATE INDEX IF NOT EXISTS "stores_plan_idx" ON "stores"("plan");
CREATE INDEX IF NOT EXISTS "stores_created_at_idx" ON "stores"("created_at");

-- categories indexes
CREATE INDEX IF NOT EXISTS "categories_store_id_idx" ON "categories"("store_id");
CREATE INDEX IF NOT EXISTS "categories_parent_id_idx" ON "categories"("parent_id");
CREATE INDEX IF NOT EXISTS "categories_is_active_idx" ON "categories"("is_active");

-- products indexes
CREATE INDEX IF NOT EXISTS "products_store_id_idx" ON "products"("store_id");
CREATE INDEX IF NOT EXISTS "products_status_idx" ON "products"("status");
CREATE INDEX IF NOT EXISTS "products_featured_idx" ON "products"("featured");
CREATE INDEX IF NOT EXISTS "products_price_idx" ON "products"("price");
CREATE INDEX IF NOT EXISTS "products_created_at_idx" ON "products"("created_at");
CREATE INDEX IF NOT EXISTS "products_store_id_status_idx" ON "products"("store_id", "status");

-- product_images indexes
CREATE INDEX IF NOT EXISTS "product_images_product_id_idx" ON "product_images"("product_id");

-- carts indexes
CREATE INDEX IF NOT EXISTS "carts_store_id_idx" ON "carts"("store_id");
CREATE INDEX IF NOT EXISTS "carts_customer_id_idx" ON "carts"("customer_id");
CREATE INDEX IF NOT EXISTS "carts_session_id_idx" ON "carts"("session_id");
CREATE INDEX IF NOT EXISTS "carts_updated_at_idx" ON "carts"("updated_at");

-- cart_items indexes
CREATE INDEX IF NOT EXISTS "cart_items_cart_id_idx" ON "cart_items"("cart_id");
CREATE INDEX IF NOT EXISTS "cart_items_product_id_idx" ON "cart_items"("product_id");

-- orders indexes
CREATE INDEX IF NOT EXISTS "orders_store_id_idx" ON "orders"("store_id");
CREATE INDEX IF NOT EXISTS "orders_customer_id_idx" ON "orders"("customer_id");
CREATE INDEX IF NOT EXISTS "orders_status_idx" ON "orders"("status");
CREATE INDEX IF NOT EXISTS "orders_payment_status_idx" ON "orders"("payment_status");
CREATE INDEX IF NOT EXISTS "orders_created_at_idx" ON "orders"("created_at");
CREATE INDEX IF NOT EXISTS "orders_store_id_customer_id_idx" ON "orders"("store_id", "customer_id");
CREATE INDEX IF NOT EXISTS "orders_store_id_status_idx" ON "orders"("store_id", "status");

-- order_items indexes
CREATE INDEX IF NOT EXISTS "order_items_order_id_idx" ON "order_items"("order_id");
CREATE INDEX IF NOT EXISTS "order_items_product_id_idx" ON "order_items"("product_id");

-- payments indexes
CREATE INDEX IF NOT EXISTS "payments_order_id_idx" ON "payments"("order_id");
CREATE INDEX IF NOT EXISTS "payments_transaction_id_idx" ON "payments"("transaction_id");
CREATE INDEX IF NOT EXISTS "payments_invoice_id_idx" ON "payments"("invoice_id");
CREATE INDEX IF NOT EXISTS "payments_status_idx" ON "payments"("status");
CREATE INDEX IF NOT EXISTS "payments_created_at_idx" ON "payments"("created_at");

-- addresses indexes
CREATE INDEX IF NOT EXISTS "addresses_user_id_idx" ON "addresses"("user_id");
CREATE INDEX IF NOT EXISTS "addresses_type_idx" ON "addresses"("type");

-- audit_logs: add missing store_id index
CREATE INDEX IF NOT EXISTS "audit_logs_store_id_idx" ON "audit_logs"("store_id");

-- ==========================================
-- Indexes on New Tables
-- ==========================================

-- verification_tokens
CREATE INDEX IF NOT EXISTS "verification_tokens_token_idx" ON "verification_tokens"("token");
CREATE INDEX IF NOT EXISTS "verification_tokens_user_id_idx" ON "verification_tokens"("user_id");

-- customers
CREATE INDEX IF NOT EXISTS "customers_store_id_idx" ON "customers"("store_id");
CREATE INDEX IF NOT EXISTS "customers_email_idx" ON "customers"("email");
CREATE INDEX IF NOT EXISTS "customers_created_at_idx" ON "customers"("created_at");

-- tags (updated - now store-scoped)
CREATE INDEX IF NOT EXISTS "tags_store_id_idx" ON "tags"("store_id");

-- product_variants
CREATE INDEX IF NOT EXISTS "product_variants_product_id_idx" ON "product_variants"("product_id");
CREATE INDEX IF NOT EXISTS "product_variants_sku_idx" ON "product_variants"("sku");

-- inventory_history
CREATE INDEX IF NOT EXISTS "inventory_history_product_id_idx" ON "inventory_history"("product_id");
CREATE INDEX IF NOT EXISTS "inventory_history_store_id_idx" ON "inventory_history"("store_id");
CREATE INDEX IF NOT EXISTS "inventory_history_created_at_idx" ON "inventory_history"("created_at");

-- payment_configs
CREATE INDEX IF NOT EXISTS "payment_configs_store_id_idx" ON "payment_configs"("store_id");
CREATE INDEX IF NOT EXISTS "payment_configs_provider_idx" ON "payment_configs"("provider");
CREATE INDEX IF NOT EXISTS "payment_configs_is_enabled_idx" ON "payment_configs"("is_enabled");

-- system_settings
CREATE INDEX IF NOT EXISTS "system_settings_category_idx" ON "system_settings"("category");

-- coupons
CREATE INDEX IF NOT EXISTS "coupons_code_idx" ON "coupons"("code");
CREATE INDEX IF NOT EXISTS "coupons_is_active_idx" ON "coupons"("is_active");

-- shipping_zones
CREATE INDEX IF NOT EXISTS "shipping_zones_store_id_idx" ON "shipping_zones"("store_id");
CREATE INDEX IF NOT EXISTS "shipping_zones_is_active_idx" ON "shipping_zones"("is_active");

-- tax_rates
CREATE INDEX IF NOT EXISTS "tax_rates_store_id_idx" ON "tax_rates"("store_id");
CREATE INDEX IF NOT EXISTS "tax_rates_country_state_idx" ON "tax_rates"("country", "state");

-- wishlists
CREATE INDEX IF NOT EXISTS "wishlists_user_id_idx" ON "wishlists"("user_id");
CREATE INDEX IF NOT EXISTS "wishlists_store_id_idx" ON "wishlists"("store_id");

-- newsletter_subscribers
CREATE INDEX IF NOT EXISTS "newsletter_subscribers_store_id_idx" ON "newsletter_subscribers"("store_id");
CREATE INDEX IF NOT EXISTS "newsletter_subscribers_is_active_idx" ON "newsletter_subscribers"("is_active");

-- reviews
CREATE INDEX IF NOT EXISTS "reviews_product_id_idx" ON "reviews"("product_id");
CREATE INDEX IF NOT EXISTS "reviews_store_id_idx" ON "reviews"("store_id");
CREATE INDEX IF NOT EXISTS "reviews_customer_id_idx" ON "reviews"("customer_id");
CREATE INDEX IF NOT EXISTS "reviews_rating_idx" ON "reviews"("rating");
CREATE INDEX IF NOT EXISTS "reviews_store_id_product_id_idx" ON "reviews"("store_id", "product_id");

-- returns
CREATE INDEX IF NOT EXISTS "returns_store_id_idx" ON "returns"("store_id");
CREATE INDEX IF NOT EXISTS "returns_order_id_idx" ON "returns"("order_id");
CREATE INDEX IF NOT EXISTS "returns_customer_id_idx" ON "returns"("customer_id");
CREATE INDEX IF NOT EXISTS "returns_status_idx" ON "returns"("status");
CREATE INDEX IF NOT EXISTS "returns_created_at_idx" ON "returns"("created_at");

-- return_items
CREATE INDEX IF NOT EXISTS "return_items_return_id_idx" ON "return_items"("return_id");
CREATE INDEX IF NOT EXISTS "return_items_product_id_idx" ON "return_items"("product_id");

-- loyalty_points
CREATE INDEX IF NOT EXISTS "loyalty_points_store_id_idx" ON "loyalty_points"("store_id");
CREATE INDEX IF NOT EXISTS "loyalty_points_customer_id_idx" ON "loyalty_points"("customer_id");

-- loyalty_transactions
CREATE INDEX IF NOT EXISTS "loyalty_transactions_store_id_idx" ON "loyalty_transactions"("store_id");
CREATE INDEX IF NOT EXISTS "loyalty_transactions_customer_id_idx" ON "loyalty_transactions"("customer_id");
CREATE INDEX IF NOT EXISTS "loyalty_transactions_order_id_idx" ON "loyalty_transactions"("order_id");
CREATE INDEX IF NOT EXISTS "loyalty_transactions_store_id_customer_id_idx" ON "loyalty_transactions"("store_id", "customer_id");

-- ==========================================
-- Foreign Keys on New Tables
-- ==========================================

-- verification_tokens
ALTER TABLE "verification_tokens" ADD CONSTRAINT "verification_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- customers
ALTER TABLE "customers" ADD CONSTRAINT "customers_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- tags: add store FK (tags now store-scoped)
-- Only add if store_id column exists and FK doesn't exist
DO $$ BEGIN
    ALTER TABLE "tags" ADD CONSTRAINT "tags_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Create unique index for tags after store_id is added
CREATE UNIQUE INDEX IF NOT EXISTS "tags_store_id_name_key" ON "tags"("store_id", "name");

-- product_options
ALTER TABLE "product_options" ADD CONSTRAINT "product_options_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- product_option_values
ALTER TABLE "product_option_values" ADD CONSTRAINT "product_option_values_option_id_fkey" FOREIGN KEY ("option_id") REFERENCES "product_options"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- product_variants
ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- product_variant_options
ALTER TABLE "product_variant_options" ADD CONSTRAINT "product_variant_options_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "product_variants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "product_variant_options" ADD CONSTRAINT "product_variant_options_value_id_fkey" FOREIGN KEY ("value_id") REFERENCES "product_option_values"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- cart_items: add variant FK
DO $$ BEGIN
    ALTER TABLE "cart_items" ADD CONSTRAINT "cart_items_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "product_variants"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- order_items: add variant FK
DO $$ BEGIN
    ALTER TABLE "order_items" ADD CONSTRAINT "order_items_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "product_variants"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- inventory_history
ALTER TABLE "inventory_history" ADD CONSTRAINT "inventory_history_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "inventory_history" ADD CONSTRAINT "inventory_history_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- payment_configs
DO $$ BEGIN
    ALTER TABLE "payment_configs" ADD CONSTRAINT "payment_configs_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- coupons
ALTER TABLE "coupons" ADD CONSTRAINT "coupons_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- shipping_zones
ALTER TABLE "shipping_zones" ADD CONSTRAINT "shipping_zones_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- tax_rates
ALTER TABLE "tax_rates" ADD CONSTRAINT "tax_rates_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- wishlists
ALTER TABLE "wishlists" ADD CONSTRAINT "wishlists_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "wishlists" ADD CONSTRAINT "wishlists_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- wishlist_items
ALTER TABLE "wishlist_items" ADD CONSTRAINT "wishlist_items_wishlist_id_fkey" FOREIGN KEY ("wishlist_id") REFERENCES "wishlists"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "wishlist_items" ADD CONSTRAINT "wishlist_items_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- newsletter_subscribers
ALTER TABLE "newsletter_subscribers" ADD CONSTRAINT "newsletter_subscribers_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- reviews
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;
DO $$ BEGIN
    ALTER TABLE "reviews" ADD CONSTRAINT "reviews_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
    ALTER TABLE "reviews" ADD CONSTRAINT "reviews_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- returns
ALTER TABLE "returns" ADD CONSTRAINT "returns_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "returns" ADD CONSTRAINT "returns_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "returns" ADD CONSTRAINT "returns_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- return_items
ALTER TABLE "return_items" ADD CONSTRAINT "return_items_return_id_fkey" FOREIGN KEY ("return_id") REFERENCES "returns"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "return_items" ADD CONSTRAINT "return_items_order_item_id_fkey" FOREIGN KEY ("order_item_id") REFERENCES "order_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "return_items" ADD CONSTRAINT "return_items_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- loyalty_points
ALTER TABLE "loyalty_points" ADD CONSTRAINT "loyalty_points_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "loyalty_points" ADD CONSTRAINT "loyalty_points_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- loyalty_transactions
ALTER TABLE "loyalty_transactions" ADD CONSTRAINT "loyalty_transactions_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "loyalty_transactions" ADD CONSTRAINT "loyalty_transactions_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
DO $$ BEGIN
    ALTER TABLE "loyalty_transactions" ADD CONSTRAINT "loyalty_transactions_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- audit_logs: add store FK
DO $$ BEGIN
    ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
