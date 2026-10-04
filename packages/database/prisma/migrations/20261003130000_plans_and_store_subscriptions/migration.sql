-- SP5 task 1: plans as DATA + per-store subscriptions (the plans/limits engine).
--
-- `plans` is a global catalog (no store_id, so no RLS: it is config, written
-- only via the super-admin Plans page). `store_subscriptions` is store-scoped
-- and carries RLS in the SAME shape as store_usage_snapshots (4 explicit
-- policies) — listed for the strict-RLS sweep.
--
-- FWB's `stores.plan` enum column STAYS (FeatureService's PLAN_BASELINE reads
-- it; removing it is invasive). `plans.feature_tier` names the enum tier a plan
-- inherits and assignPlan() keeps `stores.plan` in sync. Follow-up: retire the
-- enum once PLAN_BASELINE is keyed by plan code.
--
-- Prices are NULL (Ahmad sets them); limits are placeholders from
-- docs/ebda/research/pricing-and-packaging.md. Idempotent seed + backfill.

CREATE TYPE "SubscriptionStatus" AS ENUM ('trialing', 'active', 'past_due', 'canceled', 'comped');

CREATE TABLE "plans" (
  "id"                  TEXT NOT NULL,
  "code"                TEXT NOT NULL,
  "name_en"             TEXT NOT NULL,
  "name_ar"             TEXT NOT NULL,
  "sort"                INTEGER NOT NULL DEFAULT 0,
  "is_public"           BOOLEAN NOT NULL DEFAULT true,
  "price_monthly_minor" INTEGER,
  "price_yearly_minor"  INTEGER,
  "feature_tier"        "StorePlan" NOT NULL DEFAULT 'free',
  "limits"              JSONB NOT NULL,
  "created_at"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "plans_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "plans_code_key" ON "plans"("code");

CREATE TABLE "store_subscriptions" (
  "id"                           TEXT NOT NULL,
  "store_id"                     TEXT NOT NULL,
  "plan_code"                    TEXT NOT NULL,
  "status"                       "SubscriptionStatus" NOT NULL DEFAULT 'active',
  "current_period_start"         TIMESTAMP(3),
  "current_period_end"           TIMESTAMP(3),
  "trial_ends_at"                TIMESTAMP(3),
  "cancel_at_period_end"         BOOLEAN NOT NULL DEFAULT false,
  "provider"                     TEXT,
  "provider_customer_id"         TEXT,
  "provider_subscription_id"     TEXT,
  "provider_payment_method_ref"  TEXT,
  "orders_over_limit_month"      DATE,
  "orders_over_limit_notified_at" TIMESTAMP(3),
  "created_at"                   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"                   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "store_subscriptions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "store_subscriptions_store_id_key" ON "store_subscriptions"("store_id");
CREATE INDEX "store_subscriptions_plan_code_idx" ON "store_subscriptions"("plan_code");
CREATE INDEX "store_subscriptions_status_idx" ON "store_subscriptions"("status");

ALTER TABLE "store_subscriptions"
  ADD CONSTRAINT "store_subscriptions_store_id_fkey"
  FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "store_subscriptions"
  ADD CONSTRAINT "store_subscriptions_plan_code_fkey"
  FOREIGN KEY ("plan_code") REFERENCES "plans"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Seed plans (parity with DEFAULT_PLAN_SEEDS in @force/shared — pinned by a unit test).
-- SEED:BEGIN
INSERT INTO "plans" ("id", "code", "name_en", "name_ar", "sort", "is_public", "feature_tier", "limits") VALUES
  (gen_random_uuid()::text, 'free', 'Free', 'مجاني', 10, true, 'free', '{"maxProducts":50,"maxStaff":1,"maxOrdersPerMonth":100,"maxStorageMb":500,"customDomain":false,"platformFeeBps":150,"codPlatformFeeBps":0,"abandonedCartAutomation":false,"whatsappAutomation":false}'::jsonb),
  (gen_random_uuid()::text, 'growth', 'Growth', 'النمو', 20, true, 'starter', '{"maxProducts":1000,"maxStaff":3,"maxOrdersPerMonth":1500,"maxStorageMb":5000,"customDomain":true,"platformFeeBps":100,"codPlatformFeeBps":0,"abandonedCartAutomation":true,"whatsappAutomation":true}'::jsonb),
  (gen_random_uuid()::text, 'pro', 'Pro', 'احترافي', 30, true, 'professional', '{"maxProducts":5000,"maxStaff":10,"maxOrdersPerMonth":7000,"maxStorageMb":20000,"customDomain":true,"platformFeeBps":50,"codPlatformFeeBps":0,"abandonedCartAutomation":true,"whatsappAutomation":true}'::jsonb),
  (gen_random_uuid()::text, 'comped', 'Comped', 'مجاني بمنحة', 90, false, 'enterprise', '{"maxProducts":null,"maxStaff":null,"maxOrdersPerMonth":null,"maxStorageMb":null,"customDomain":true,"platformFeeBps":0,"codPlatformFeeBps":0,"abandonedCartAutomation":true,"whatsappAutomation":true}'::jsonb)
ON CONFLICT ("code") DO NOTHING;
-- SEED:END

-- Map FWB's stores.plan enum onto plan codes (one subscription per existing store).
-- free -> free, starter -> growth, professional -> pro, enterprise -> comped.
-- BACKFILL:BEGIN
INSERT INTO "store_subscriptions" ("id", "store_id", "plan_code", "status")
SELECT
  gen_random_uuid()::text,
  s."id",
  CASE s."plan"
    WHEN 'free' THEN 'free'
    WHEN 'starter' THEN 'growth'
    WHEN 'professional' THEN 'pro'
    WHEN 'enterprise' THEN 'comped'
  END,
  CASE WHEN s."plan" = 'enterprise' THEN 'comped'::"SubscriptionStatus" ELSE 'active'::"SubscriptionStatus" END
FROM "stores" s
ON CONFLICT ("store_id") DO NOTHING;
-- BACKFILL:END

-- RLS on the store-scoped table (same 4-policy shape as store_usage_snapshots).
ALTER TABLE "store_subscriptions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "store_subscriptions" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "store_subscriptions_app_select" ON "store_subscriptions";
CREATE POLICY "store_subscriptions_app_select" ON "store_subscriptions" FOR SELECT
  USING (current_store_id() IS NULL OR current_setting('app.bypass_rls', true) = 'true' OR store_id = current_store_id());

DROP POLICY IF EXISTS "store_subscriptions_app_insert" ON "store_subscriptions";
CREATE POLICY "store_subscriptions_app_insert" ON "store_subscriptions" FOR INSERT
  WITH CHECK (current_store_id() IS NULL OR current_setting('app.bypass_rls', true) = 'true' OR store_id = current_store_id());

DROP POLICY IF EXISTS "store_subscriptions_app_update" ON "store_subscriptions";
CREATE POLICY "store_subscriptions_app_update" ON "store_subscriptions" FOR UPDATE
  USING (current_store_id() IS NULL OR current_setting('app.bypass_rls', true) = 'true' OR store_id = current_store_id())
  WITH CHECK (current_store_id() IS NULL OR current_setting('app.bypass_rls', true) = 'true' OR store_id = current_store_id());

DROP POLICY IF EXISTS "store_subscriptions_app_delete" ON "store_subscriptions";
CREATE POLICY "store_subscriptions_app_delete" ON "store_subscriptions" FOR DELETE
  USING (current_store_id() IS NULL OR current_setting('app.bypass_rls', true) = 'true' OR store_id = current_store_id());
