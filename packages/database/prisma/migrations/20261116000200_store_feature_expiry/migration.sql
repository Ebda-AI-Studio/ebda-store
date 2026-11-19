-- Ruling SF-EXPIRY-1 (issue 843): a StoreFeature override can expire and says why it exists. Both columns are nullable
-- (NULL expires_at = never, today's behaviour for every existing row), so the previous release keeps working against this
-- schema (expand-only). The D1 twin is platform/0017_store_feature_expiry.
ALTER TABLE "store_features" ADD COLUMN IF NOT EXISTS "expires_at" TIMESTAMP(3);
ALTER TABLE "store_features" ADD COLUMN IF NOT EXISTS "reason" TEXT;
