-- Migration: store_lifecycle_emails.
-- One row per (store, lifecycle email kind): the idempotency handle of the self-serve onboarding emails
-- (setup nudges, trial recap, first-order referral ask) and the log the merchant reads at
-- /stores/[id]/lifecycle-emails. kind 'optout' is the merchant's unsubscribe.
CREATE TABLE "store_lifecycle_emails" (
  "id" TEXT NOT NULL,
  "store_id" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "reason" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "store_lifecycle_emails_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "store_lifecycle_emails_kind_check" CHECK ("kind" IN ('add_products', 'payment_shipping', 'test_order', 'share_link', 'trial_recap', 'first_order', 'optout')),
  CONSTRAINT "store_lifecycle_emails_status_check" CHECK ("status" IN ('sent', 'skipped', 'failed'))
);
CREATE UNIQUE INDEX "store_lifecycle_emails_store_id_kind_key" ON "store_lifecycle_emails"("store_id", "kind");
CREATE INDEX "store_lifecycle_emails_store_id_created_at_idx" ON "store_lifecycle_emails"("store_id", "created_at");
ALTER TABLE "store_lifecycle_emails" ADD CONSTRAINT "store_lifecycle_emails_store_id_fkey"
  FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE store_lifecycle_emails ENABLE ROW LEVEL SECURITY;
ALTER TABLE store_lifecycle_emails FORCE ROW LEVEL SECURITY;
CREATE POLICY ebda_tenant_isolation ON store_lifecycle_emails AS PERMISSIVE FOR ALL TO ebda_app
  USING (store_id = nullif(current_setting('app.current_store_id', true), ''))
  WITH CHECK (store_id = nullif(current_setting('app.current_store_id', true), ''));
