-- Issue 206 — promotional-SMS consent, per customer per store.
--
-- Creates one empty table. Inserts nothing, backfills nothing and sends
-- nothing: `orders.sms_opt_in` rows are NOT copied in, because no storefront
-- ever rendered the checkout checkbox that field was meant for (the web app
-- never sent `smsOptIn`), so a true value there is not evidence of a tick.

CREATE TYPE "SmsConsentSource" AS ENUM ('checkout', 'account', 'unsubscribe');

CREATE TABLE "sms_marketing_consents" (
    "id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "customer_key" TEXT NOT NULL,
    "user_id" TEXT,
    "phone" TEXT NOT NULL,
    "phone_key" TEXT NOT NULL,
    "granted" BOOLEAN NOT NULL DEFAULT false,
    "granted_at" TIMESTAMP(3),
    "granted_source" "SmsConsentSource",
    "revoked_at" TIMESTAMP(3),
    "revoked_source" "SmsConsentSource",
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sms_marketing_consents_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "sms_marketing_consents_store_id_customer_key_key" ON "sms_marketing_consents"("store_id", "customer_key");
CREATE INDEX "sms_marketing_consents_store_id_phone_key_idx" ON "sms_marketing_consents"("store_id", "phone_key");
CREATE INDEX "sms_marketing_consents_user_id_idx" ON "sms_marketing_consents"("user_id");

ALTER TABLE "sms_marketing_consents" ADD CONSTRAINT "sms_marketing_consents_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "sms_marketing_consents" ADD CONSTRAINT "sms_marketing_consents_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RLS: same force_app-path policies as 20260911190000_merchant_api_keys.
ALTER TABLE "sms_marketing_consents" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sms_marketing_consents" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "sms_marketing_consents_app_select" ON "sms_marketing_consents";
CREATE POLICY "sms_marketing_consents_app_select" ON "sms_marketing_consents" FOR SELECT
  USING (current_store_id() IS NULL OR current_setting('app.bypass_rls', true) = 'true' OR store_id = current_store_id());

DROP POLICY IF EXISTS "sms_marketing_consents_app_insert" ON "sms_marketing_consents";
CREATE POLICY "sms_marketing_consents_app_insert" ON "sms_marketing_consents" FOR INSERT
  WITH CHECK (current_store_id() IS NULL OR current_setting('app.bypass_rls', true) = 'true' OR store_id = current_store_id());

DROP POLICY IF EXISTS "sms_marketing_consents_app_update" ON "sms_marketing_consents";
CREATE POLICY "sms_marketing_consents_app_update" ON "sms_marketing_consents" FOR UPDATE
  USING (current_store_id() IS NULL OR current_setting('app.bypass_rls', true) = 'true' OR store_id = current_store_id())
  WITH CHECK (current_store_id() IS NULL OR current_setting('app.bypass_rls', true) = 'true' OR store_id = current_store_id());

DROP POLICY IF EXISTS "sms_marketing_consents_app_delete" ON "sms_marketing_consents";
CREATE POLICY "sms_marketing_consents_app_delete" ON "sms_marketing_consents" FOR DELETE
  USING (current_store_id() IS NULL OR current_setting('app.bypass_rls', true) = 'true' OR store_id = current_store_id());
