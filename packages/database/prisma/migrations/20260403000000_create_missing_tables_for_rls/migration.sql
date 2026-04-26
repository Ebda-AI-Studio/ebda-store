-- Backfill the 15 tables that are referenced by the next migration
-- (20260404000000_add_rls_policies) but were never created by any earlier
-- migration. They exist on production (introduced via `prisma db push`
-- before strict migration ordering was enforced) but a fresh CI / E2E DB
-- has nothing yet, so the RLS migration crashes with
-- `relation "store_features" does not exist`.
--
-- Every CREATE TABLE / CREATE INDEX uses IF NOT EXISTS, and every
-- ADD CONSTRAINT is preceded by a DROP CONSTRAINT IF EXISTS, so this
-- migration is a no-op on production and a creator on fresh databases.

CREATE TABLE IF NOT EXISTS "store_features" (
    "id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "feature_key" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "enabled_at" TIMESTAMP(3),
    "enabled_by" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "store_features_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "notification_configs" (
    "id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "credentials" TEXT NOT NULL DEFAULT '',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notification_configs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "notification_event_configs" (
    "id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "whatsapp" BOOLEAN NOT NULL DEFAULT true,
    "sms" BOOLEAN NOT NULL DEFAULT true,
    "push" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "notification_event_configs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "push_subscriptions" (
    "id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "customer_id" TEXT,
    "endpoint" TEXT NOT NULL,
    "p256dh" TEXT NOT NULL,
    "auth" TEXT NOT NULL,
    "device_info" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "push_subscriptions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "notification_logs" (
    "id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "recipient_phone_hash" TEXT,
    "recipient_email_hash" TEXT,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "provider_message_id" TEXT,
    "idempotency_key" TEXT,
    "error" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notification_logs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "abandoned_carts" (
    "id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "cart_id" TEXT NOT NULL,
    "customer_id" TEXT,
    "session_id" TEXT,
    "customer_email" TEXT,
    "customer_phone" TEXT,
    "cart_total" DECIMAL(12,3) NOT NULL,
    "cart_item_count" INTEGER NOT NULL,
    "cart_items" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "step1_sent_at" TIMESTAMP(3),
    "step2_sent_at" TIMESTAMP(3),
    "step3_sent_at" TIMESTAMP(3),
    "recovered_at" TIMESTAMP(3),
    "recovered_order_id" TEXT,
    "coupon_id" TEXT,
    "next_step_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "abandoned_carts_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "abandoned_cart_configs" (
    "id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "step1_enabled" BOOLEAN NOT NULL DEFAULT true,
    "step1_delay_minutes" INTEGER NOT NULL DEFAULT 60,
    "step2_enabled" BOOLEAN NOT NULL DEFAULT true,
    "step2_delay_minutes" INTEGER NOT NULL DEFAULT 240,
    "step3_enabled" BOOLEAN NOT NULL DEFAULT true,
    "step3_delay_minutes" INTEGER NOT NULL DEFAULT 1440,
    "auto_coupon_enabled" BOOLEAN NOT NULL DEFAULT true,
    "coupon_discount_percent" INTEGER NOT NULL DEFAULT 10,
    "coupon_max_discount" DECIMAL(12,3),
    "coupon_expiry_hours" INTEGER NOT NULL DEFAULT 48,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "abandoned_cart_configs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "product_relations" (
    "id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "source_product_id" TEXT NOT NULL,
    "target_product_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_relations_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "frequently_bought_together" (
    "id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "product_id_1" TEXT NOT NULL,
    "product_id_2" TEXT NOT NULL,
    "co_occurrence_count" INTEGER NOT NULL DEFAULT 0,
    "last_calculated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "frequently_bought_together_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "shipping_carrier_configs" (
    "id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "carrier" TEXT NOT NULL,
    "credentials" TEXT NOT NULL DEFAULT '',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "settings" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shipping_carrier_configs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "shipments" (
    "id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "carrier" TEXT NOT NULL,
    "tracking_number" TEXT,
    "tracking_url" TEXT,
    "label_url" TEXT,
    "status" TEXT NOT NULL DEFAULT 'created',
    "carrier_shipment_id" TEXT,
    "pickup_address" JSONB NOT NULL,
    "delivery_address" JSONB NOT NULL,
    "weight" DECIMAL(8,2),
    "dimensions" JSONB,
    "estimated_delivery_at" TIMESTAMP(3),
    "status_history" JSONB NOT NULL DEFAULT '[]',
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shipments_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "affiliates" (
    "id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "instagram" TEXT,
    "tiktok" TEXT,
    "referral_code" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "commission_rate" DECIMAL(5,2),
    "total_earned" DECIMAL(12,3) NOT NULL DEFAULT 0,
    "total_paid" DECIMAL(12,3) NOT NULL DEFAULT 0,
    "pending_balance" DECIMAL(12,3) NOT NULL DEFAULT 0,
    "approved_at" TIMESTAMP(3),
    "approved_by" TEXT,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "affiliates_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "affiliate_referrals" (
    "id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "affiliate_id" TEXT NOT NULL,
    "order_id" TEXT,
    "session_id" TEXT,
    "referral_code" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'clicked',
    "commission_amount" DECIMAL(12,3),
    "converted_at" TIMESTAMP(3),
    "cookie_expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "affiliate_referrals_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "affiliate_payouts" (
    "id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "affiliate_id" TEXT NOT NULL,
    "amount" DECIMAL(12,3) NOT NULL,
    "method" TEXT NOT NULL DEFAULT 'manual',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "paid_at" TIMESTAMP(3),
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "affiliate_payouts_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "affiliate_configs" (
    "id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "default_commission_rate" DECIMAL(5,2) NOT NULL DEFAULT 10,
    "cookie_duration_days" INTEGER NOT NULL DEFAULT 30,
    "min_payout_amount" DECIMAL(12,3) NOT NULL DEFAULT 5000,
    "auto_approve" BOOLEAN NOT NULL DEFAULT false,
    "public_signup_enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "affiliate_configs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "store_features_store_id_idx" ON "store_features"("store_id");

CREATE UNIQUE INDEX IF NOT EXISTS "store_features_store_id_feature_key_key" ON "store_features"("store_id", "feature_key");

CREATE INDEX IF NOT EXISTS "notification_configs_store_id_idx" ON "notification_configs"("store_id");

CREATE UNIQUE INDEX IF NOT EXISTS "notification_configs_store_id_channel_key" ON "notification_configs"("store_id", "channel");

CREATE INDEX IF NOT EXISTS "notification_event_configs_store_id_idx" ON "notification_event_configs"("store_id");

CREATE UNIQUE INDEX IF NOT EXISTS "notification_event_configs_store_id_event_key" ON "notification_event_configs"("store_id", "event");

CREATE INDEX IF NOT EXISTS "push_subscriptions_store_id_idx" ON "push_subscriptions"("store_id");

CREATE INDEX IF NOT EXISTS "push_subscriptions_customer_id_idx" ON "push_subscriptions"("customer_id");

CREATE UNIQUE INDEX IF NOT EXISTS "push_subscriptions_store_id_endpoint_key" ON "push_subscriptions"("store_id", "endpoint");

CREATE UNIQUE INDEX IF NOT EXISTS "notification_logs_idempotency_key_key" ON "notification_logs"("idempotency_key");

CREATE INDEX IF NOT EXISTS "notification_logs_store_id_idx" ON "notification_logs"("store_id");

CREATE INDEX IF NOT EXISTS "notification_logs_store_id_channel_idx" ON "notification_logs"("store_id", "channel");

CREATE INDEX IF NOT EXISTS "notification_logs_store_id_event_idx" ON "notification_logs"("store_id", "event");

CREATE INDEX IF NOT EXISTS "notification_logs_status_idx" ON "notification_logs"("status");

CREATE UNIQUE INDEX IF NOT EXISTS "abandoned_carts_cart_id_key" ON "abandoned_carts"("cart_id");

CREATE INDEX IF NOT EXISTS "abandoned_carts_store_id_idx" ON "abandoned_carts"("store_id");

CREATE INDEX IF NOT EXISTS "abandoned_carts_store_id_status_idx" ON "abandoned_carts"("store_id", "status");

CREATE INDEX IF NOT EXISTS "abandoned_carts_next_step_at_idx" ON "abandoned_carts"("next_step_at");

CREATE UNIQUE INDEX IF NOT EXISTS "abandoned_carts_store_id_cart_id_key" ON "abandoned_carts"("store_id", "cart_id");

CREATE UNIQUE INDEX IF NOT EXISTS "abandoned_cart_configs_store_id_key" ON "abandoned_cart_configs"("store_id");

CREATE INDEX IF NOT EXISTS "product_relations_store_id_source_product_id_idx" ON "product_relations"("store_id", "source_product_id");

CREATE INDEX IF NOT EXISTS "product_relations_store_id_target_product_id_idx" ON "product_relations"("store_id", "target_product_id");

CREATE UNIQUE INDEX IF NOT EXISTS "product_relations_store_id_source_product_id_target_product_key" ON "product_relations"("store_id", "source_product_id", "target_product_id", "type");

CREATE INDEX IF NOT EXISTS "frequently_bought_together_store_id_product_id_1_idx" ON "frequently_bought_together"("store_id", "product_id_1");

CREATE INDEX IF NOT EXISTS "frequently_bought_together_store_id_product_id_2_idx" ON "frequently_bought_together"("store_id", "product_id_2");

CREATE INDEX IF NOT EXISTS "frequently_bought_together_co_occurrence_count_idx" ON "frequently_bought_together"("co_occurrence_count");

CREATE UNIQUE INDEX IF NOT EXISTS "frequently_bought_together_store_id_product_id_1_product_id_key" ON "frequently_bought_together"("store_id", "product_id_1", "product_id_2");

CREATE INDEX IF NOT EXISTS "shipping_carrier_configs_store_id_idx" ON "shipping_carrier_configs"("store_id");

CREATE UNIQUE INDEX IF NOT EXISTS "shipping_carrier_configs_store_id_carrier_key" ON "shipping_carrier_configs"("store_id", "carrier");

CREATE UNIQUE INDEX IF NOT EXISTS "shipments_order_id_key" ON "shipments"("order_id");

CREATE INDEX IF NOT EXISTS "shipments_store_id_idx" ON "shipments"("store_id");

CREATE INDEX IF NOT EXISTS "shipments_tracking_number_idx" ON "shipments"("tracking_number");

CREATE INDEX IF NOT EXISTS "shipments_store_id_status_idx" ON "shipments"("store_id", "status");

CREATE INDEX IF NOT EXISTS "affiliates_store_id_idx" ON "affiliates"("store_id");

CREATE INDEX IF NOT EXISTS "affiliates_status_idx" ON "affiliates"("status");

CREATE UNIQUE INDEX IF NOT EXISTS "affiliates_store_id_referral_code_key" ON "affiliates"("store_id", "referral_code");

CREATE UNIQUE INDEX IF NOT EXISTS "affiliates_store_id_email_key" ON "affiliates"("store_id", "email");

CREATE INDEX IF NOT EXISTS "affiliate_referrals_store_id_idx" ON "affiliate_referrals"("store_id");

CREATE INDEX IF NOT EXISTS "affiliate_referrals_affiliate_id_idx" ON "affiliate_referrals"("affiliate_id");

CREATE INDEX IF NOT EXISTS "affiliate_referrals_order_id_idx" ON "affiliate_referrals"("order_id");

CREATE INDEX IF NOT EXISTS "affiliate_referrals_referral_code_idx" ON "affiliate_referrals"("referral_code");

CREATE INDEX IF NOT EXISTS "affiliate_referrals_status_idx" ON "affiliate_referrals"("status");

CREATE INDEX IF NOT EXISTS "affiliate_payouts_store_id_idx" ON "affiliate_payouts"("store_id");

CREATE INDEX IF NOT EXISTS "affiliate_payouts_affiliate_id_idx" ON "affiliate_payouts"("affiliate_id");

CREATE INDEX IF NOT EXISTS "affiliate_payouts_status_idx" ON "affiliate_payouts"("status");

CREATE UNIQUE INDEX IF NOT EXISTS "affiliate_configs_store_id_key" ON "affiliate_configs"("store_id");

ALTER TABLE "store_features" DROP CONSTRAINT IF EXISTS "store_features_store_id_fkey";

ALTER TABLE "store_features" ADD CONSTRAINT "store_features_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "store_features" DROP CONSTRAINT IF EXISTS "store_features_enabled_by_fkey";

ALTER TABLE "store_features" ADD CONSTRAINT "store_features_enabled_by_fkey" FOREIGN KEY ("enabled_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "notification_configs" DROP CONSTRAINT IF EXISTS "notification_configs_store_id_fkey";

ALTER TABLE "notification_configs" ADD CONSTRAINT "notification_configs_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "notification_event_configs" DROP CONSTRAINT IF EXISTS "notification_event_configs_store_id_fkey";

ALTER TABLE "notification_event_configs" ADD CONSTRAINT "notification_event_configs_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "push_subscriptions" DROP CONSTRAINT IF EXISTS "push_subscriptions_store_id_fkey";

ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "push_subscriptions" DROP CONSTRAINT IF EXISTS "push_subscriptions_customer_id_fkey";

ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "notification_logs" DROP CONSTRAINT IF EXISTS "notification_logs_store_id_fkey";

ALTER TABLE "notification_logs" ADD CONSTRAINT "notification_logs_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "abandoned_carts" DROP CONSTRAINT IF EXISTS "abandoned_carts_store_id_fkey";

ALTER TABLE "abandoned_carts" ADD CONSTRAINT "abandoned_carts_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "abandoned_carts" DROP CONSTRAINT IF EXISTS "abandoned_carts_cart_id_fkey";

ALTER TABLE "abandoned_carts" ADD CONSTRAINT "abandoned_carts_cart_id_fkey" FOREIGN KEY ("cart_id") REFERENCES "carts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "abandoned_carts" DROP CONSTRAINT IF EXISTS "abandoned_carts_customer_id_fkey";

ALTER TABLE "abandoned_carts" ADD CONSTRAINT "abandoned_carts_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "abandoned_carts" DROP CONSTRAINT IF EXISTS "abandoned_carts_coupon_id_fkey";

ALTER TABLE "abandoned_carts" ADD CONSTRAINT "abandoned_carts_coupon_id_fkey" FOREIGN KEY ("coupon_id") REFERENCES "coupons"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "abandoned_cart_configs" DROP CONSTRAINT IF EXISTS "abandoned_cart_configs_store_id_fkey";

ALTER TABLE "abandoned_cart_configs" ADD CONSTRAINT "abandoned_cart_configs_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "product_relations" DROP CONSTRAINT IF EXISTS "product_relations_store_id_fkey";

ALTER TABLE "product_relations" ADD CONSTRAINT "product_relations_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "product_relations" DROP CONSTRAINT IF EXISTS "product_relations_source_product_id_fkey";

ALTER TABLE "product_relations" ADD CONSTRAINT "product_relations_source_product_id_fkey" FOREIGN KEY ("source_product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "product_relations" DROP CONSTRAINT IF EXISTS "product_relations_target_product_id_fkey";

ALTER TABLE "product_relations" ADD CONSTRAINT "product_relations_target_product_id_fkey" FOREIGN KEY ("target_product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "frequently_bought_together" DROP CONSTRAINT IF EXISTS "frequently_bought_together_store_id_fkey";

ALTER TABLE "frequently_bought_together" ADD CONSTRAINT "frequently_bought_together_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "frequently_bought_together" DROP CONSTRAINT IF EXISTS "frequently_bought_together_product_id_1_fkey";

ALTER TABLE "frequently_bought_together" ADD CONSTRAINT "frequently_bought_together_product_id_1_fkey" FOREIGN KEY ("product_id_1") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "frequently_bought_together" DROP CONSTRAINT IF EXISTS "frequently_bought_together_product_id_2_fkey";

ALTER TABLE "frequently_bought_together" ADD CONSTRAINT "frequently_bought_together_product_id_2_fkey" FOREIGN KEY ("product_id_2") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "shipping_carrier_configs" DROP CONSTRAINT IF EXISTS "shipping_carrier_configs_store_id_fkey";

ALTER TABLE "shipping_carrier_configs" ADD CONSTRAINT "shipping_carrier_configs_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "shipments" DROP CONSTRAINT IF EXISTS "shipments_store_id_fkey";

ALTER TABLE "shipments" ADD CONSTRAINT "shipments_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "shipments" DROP CONSTRAINT IF EXISTS "shipments_order_id_fkey";

ALTER TABLE "shipments" ADD CONSTRAINT "shipments_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "affiliates" DROP CONSTRAINT IF EXISTS "affiliates_store_id_fkey";

ALTER TABLE "affiliates" ADD CONSTRAINT "affiliates_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "affiliate_referrals" DROP CONSTRAINT IF EXISTS "affiliate_referrals_store_id_fkey";

ALTER TABLE "affiliate_referrals" ADD CONSTRAINT "affiliate_referrals_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "affiliate_referrals" DROP CONSTRAINT IF EXISTS "affiliate_referrals_affiliate_id_fkey";

ALTER TABLE "affiliate_referrals" ADD CONSTRAINT "affiliate_referrals_affiliate_id_fkey" FOREIGN KEY ("affiliate_id") REFERENCES "affiliates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "affiliate_referrals" DROP CONSTRAINT IF EXISTS "affiliate_referrals_order_id_fkey";

ALTER TABLE "affiliate_referrals" ADD CONSTRAINT "affiliate_referrals_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "affiliate_payouts" DROP CONSTRAINT IF EXISTS "affiliate_payouts_store_id_fkey";

ALTER TABLE "affiliate_payouts" ADD CONSTRAINT "affiliate_payouts_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "affiliate_payouts" DROP CONSTRAINT IF EXISTS "affiliate_payouts_affiliate_id_fkey";

ALTER TABLE "affiliate_payouts" ADD CONSTRAINT "affiliate_payouts_affiliate_id_fkey" FOREIGN KEY ("affiliate_id") REFERENCES "affiliates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "affiliate_configs" DROP CONSTRAINT IF EXISTS "affiliate_configs_store_id_fkey";

ALTER TABLE "affiliate_configs" ADD CONSTRAINT "affiliate_configs_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;
