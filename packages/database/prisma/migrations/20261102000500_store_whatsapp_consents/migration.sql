-- Ruling WA-CONSENT-1: WhatsApp MARKETING consent per store and buyer (cart reminders are marketing;
-- PDPL needs prior consent). Keyed by the suite buyer key (HMAC of the E.164 phone), never the phone.
CREATE TABLE "store_whatsapp_consents" (
  "store_id" TEXT NOT NULL,
  "buyer_key" TEXT NOT NULL,
  "granted" BOOLEAN NOT NULL DEFAULT false,
  "granted_at" TIMESTAMP(3),
  "granted_source" TEXT,
  "locale" TEXT,
  "revoked_at" TIMESTAMP(3),
  "revoked_source" TEXT,
  "opt_out_version" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "store_whatsapp_consents_pkey" PRIMARY KEY ("store_id", "buyer_key"),
  CONSTRAINT "store_whatsapp_consents_buyer_key_check" CHECK ("buyer_key" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "store_whatsapp_consents_granted_source_check" CHECK ("granted_source" IS NULL OR "granted_source" IN ('checkout', 'cart', 'admin', 'whatsapp')),
  CONSTRAINT "store_whatsapp_consents_revoked_source_check" CHECK ("revoked_source" IS NULL OR "revoked_source" IN ('checkout', 'cart', 'admin', 'whatsapp', 'erasure'))
);
CREATE INDEX "store_whatsapp_consents_buyer_key_idx" ON "store_whatsapp_consents"("buyer_key");
ALTER TABLE "store_whatsapp_consents" ADD CONSTRAINT "store_whatsapp_consents_store_id_fkey"
  FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE store_whatsapp_consents ENABLE ROW LEVEL SECURITY;
ALTER TABLE store_whatsapp_consents FORCE ROW LEVEL SECURITY;
CREATE POLICY ebda_tenant_isolation ON store_whatsapp_consents AS PERMISSIVE FOR ALL TO ebda_app
  USING (store_id = nullif(current_setting('app.current_store_id', true), ''))
  WITH CHECK (store_id = nullif(current_setting('app.current_store_id', true), ''));
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "store_whatsapp_consents" TO ebda_app;
