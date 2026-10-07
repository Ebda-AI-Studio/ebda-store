-- Locked pricing (2026-10-05, docs/plans/2026-10-05-pricing-decisions.md).
-- Brings `plans` to the locked catalog: Basic/Growth/Business public + priced, no free plan,
-- 0 platform fee everywhere. Historical rows (free/pro/comped) are KEPT, hidden, with zeroed
-- fees, so store_subscriptions.plan_code references keep resolving; no merchant is reassigned.
-- founding_free (Amelia) is created hidden and assigned to nobody. The limits JSON of every row is
-- the FULL current shape (new keys: maxStores, brandingRemoval, apiAccess, analyticsTier, supportTier).
-- Parity with DEFAULT_PLAN_SEEDS is pinned by tests/unit/locked-pricing.test.ts.

-- PLAN:free
INSERT INTO plans (id, code, name_en, name_ar, sort, is_public, feature_tier, price_monthly_minor, price_yearly_minor, limits)
VALUES (gen_random_uuid()::text, 'free', 'Free', 'مجاني', 80, false, 'free', NULL, NULL, '{"maxProducts":50,"maxStaff":1,"maxOrdersPerMonth":100,"maxStorageMb":500,"maxStores":1,"customDomain":false,"platformFeeBps":0,"codPlatformFeeBps":0,"abandonedCartAutomation":false,"whatsappAutomation":false,"brandingRemoval":false,"apiAccess":false,"analyticsTier":"advanced","supportTier":"email"}'::jsonb)
ON CONFLICT (code) DO UPDATE SET name_en = EXCLUDED.name_en, name_ar = EXCLUDED.name_ar, sort = EXCLUDED.sort, is_public = EXCLUDED.is_public, feature_tier = EXCLUDED.feature_tier, price_monthly_minor = EXCLUDED.price_monthly_minor, price_yearly_minor = EXCLUDED.price_yearly_minor, limits = EXCLUDED.limits, updated_at = CURRENT_TIMESTAMP;

-- PLAN:basic
INSERT INTO plans (id, code, name_en, name_ar, sort, is_public, feature_tier, price_monthly_minor, price_yearly_minor, limits)
VALUES (gen_random_uuid()::text, 'basic', 'Basic', 'الأساسية', 10, true, 'starter', 149000, 1341000, '{"maxProducts":null,"maxStaff":2,"maxOrdersPerMonth":300,"maxStorageMb":null,"maxStores":1,"customDomain":true,"platformFeeBps":0,"codPlatformFeeBps":0,"abandonedCartAutomation":false,"whatsappAutomation":false,"brandingRemoval":false,"apiAccess":false,"analyticsTier":"basic","supportTier":"email"}'::jsonb)
ON CONFLICT (code) DO UPDATE SET name_en = EXCLUDED.name_en, name_ar = EXCLUDED.name_ar, sort = EXCLUDED.sort, is_public = EXCLUDED.is_public, feature_tier = EXCLUDED.feature_tier, price_monthly_minor = EXCLUDED.price_monthly_minor, price_yearly_minor = EXCLUDED.price_yearly_minor, limits = EXCLUDED.limits, updated_at = CURRENT_TIMESTAMP;

-- PLAN:growth
INSERT INTO plans (id, code, name_en, name_ar, sort, is_public, feature_tier, price_monthly_minor, price_yearly_minor, limits)
VALUES (gen_random_uuid()::text, 'growth', 'Growth', 'النمو', 20, true, 'professional', 349000, 3141000, '{"maxProducts":null,"maxStaff":5,"maxOrdersPerMonth":3000,"maxStorageMb":null,"maxStores":1,"customDomain":true,"platformFeeBps":0,"codPlatformFeeBps":0,"abandonedCartAutomation":true,"whatsappAutomation":false,"brandingRemoval":true,"apiAccess":false,"analyticsTier":"standard","supportTier":"chat"}'::jsonb)
ON CONFLICT (code) DO UPDATE SET name_en = EXCLUDED.name_en, name_ar = EXCLUDED.name_ar, sort = EXCLUDED.sort, is_public = EXCLUDED.is_public, feature_tier = EXCLUDED.feature_tier, price_monthly_minor = EXCLUDED.price_monthly_minor, price_yearly_minor = EXCLUDED.price_yearly_minor, limits = EXCLUDED.limits, updated_at = CURRENT_TIMESTAMP;

-- PLAN:business
INSERT INTO plans (id, code, name_en, name_ar, sort, is_public, feature_tier, price_monthly_minor, price_yearly_minor, limits)
VALUES (gen_random_uuid()::text, 'business', 'Business', 'الأعمال', 30, true, 'enterprise', 999000, 8991000, '{"maxProducts":null,"maxStaff":15,"maxOrdersPerMonth":null,"maxStorageMb":null,"maxStores":3,"customDomain":true,"platformFeeBps":0,"codPlatformFeeBps":0,"abandonedCartAutomation":true,"whatsappAutomation":false,"brandingRemoval":true,"apiAccess":true,"analyticsTier":"advanced","supportTier":"priority"}'::jsonb)
ON CONFLICT (code) DO UPDATE SET name_en = EXCLUDED.name_en, name_ar = EXCLUDED.name_ar, sort = EXCLUDED.sort, is_public = EXCLUDED.is_public, feature_tier = EXCLUDED.feature_tier, price_monthly_minor = EXCLUDED.price_monthly_minor, price_yearly_minor = EXCLUDED.price_yearly_minor, limits = EXCLUDED.limits, updated_at = CURRENT_TIMESTAMP;

-- PLAN:pro
INSERT INTO plans (id, code, name_en, name_ar, sort, is_public, feature_tier, price_monthly_minor, price_yearly_minor, limits)
VALUES (gen_random_uuid()::text, 'pro', 'Pro', 'احترافي', 85, false, 'professional', NULL, NULL, '{"maxProducts":5000,"maxStaff":10,"maxOrdersPerMonth":7000,"maxStorageMb":20000,"maxStores":null,"customDomain":true,"platformFeeBps":0,"codPlatformFeeBps":0,"abandonedCartAutomation":true,"whatsappAutomation":true,"brandingRemoval":false,"apiAccess":false,"analyticsTier":"advanced","supportTier":"chat"}'::jsonb)
ON CONFLICT (code) DO UPDATE SET name_en = EXCLUDED.name_en, name_ar = EXCLUDED.name_ar, sort = EXCLUDED.sort, is_public = EXCLUDED.is_public, feature_tier = EXCLUDED.feature_tier, price_monthly_minor = EXCLUDED.price_monthly_minor, price_yearly_minor = EXCLUDED.price_yearly_minor, limits = EXCLUDED.limits, updated_at = CURRENT_TIMESTAMP;

-- PLAN:comped
INSERT INTO plans (id, code, name_en, name_ar, sort, is_public, feature_tier, price_monthly_minor, price_yearly_minor, limits)
VALUES (gen_random_uuid()::text, 'comped', 'Comped', 'مجاني بمنحة', 90, false, 'enterprise', NULL, NULL, '{"maxProducts":null,"maxStaff":null,"maxOrdersPerMonth":null,"maxStorageMb":null,"maxStores":null,"customDomain":true,"platformFeeBps":0,"codPlatformFeeBps":0,"abandonedCartAutomation":true,"whatsappAutomation":true,"brandingRemoval":false,"apiAccess":false,"analyticsTier":"advanced","supportTier":"priority"}'::jsonb)
ON CONFLICT (code) DO UPDATE SET name_en = EXCLUDED.name_en, name_ar = EXCLUDED.name_ar, sort = EXCLUDED.sort, is_public = EXCLUDED.is_public, feature_tier = EXCLUDED.feature_tier, price_monthly_minor = EXCLUDED.price_monthly_minor, price_yearly_minor = EXCLUDED.price_yearly_minor, limits = EXCLUDED.limits, updated_at = CURRENT_TIMESTAMP;

-- PLAN:founding_free
INSERT INTO plans (id, code, name_en, name_ar, sort, is_public, feature_tier, price_monthly_minor, price_yearly_minor, limits)
VALUES (gen_random_uuid()::text, 'founding_free', 'Founding (free)', 'مؤسس (مجاني)', 95, false, 'enterprise', NULL, NULL, '{"maxProducts":null,"maxStaff":null,"maxOrdersPerMonth":null,"maxStorageMb":null,"maxStores":null,"customDomain":true,"platformFeeBps":0,"codPlatformFeeBps":0,"abandonedCartAutomation":true,"whatsappAutomation":false,"brandingRemoval":true,"apiAccess":true,"analyticsTier":"advanced","supportTier":"priority"}'::jsonb)
ON CONFLICT (code) DO UPDATE SET name_en = EXCLUDED.name_en, name_ar = EXCLUDED.name_ar, sort = EXCLUDED.sort, is_public = EXCLUDED.is_public, feature_tier = EXCLUDED.feature_tier, price_monthly_minor = EXCLUDED.price_monthly_minor, price_yearly_minor = EXCLUDED.price_yearly_minor, limits = EXCLUDED.limits, updated_at = CURRENT_TIMESTAMP;

