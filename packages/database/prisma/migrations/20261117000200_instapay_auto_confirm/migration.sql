-- InstaPay auto-confirm (Ruling INSTAPAY-AUTO-1): one row per receipt the auto path decided on. Production reads and writes the D1 twin
-- (packages/cf-schema migrations/platform 0013); this Postgres table keeps Node/tests and the Prisma model in step.
CREATE TABLE "instapay_auto_confirmations" (
  "id" TEXT NOT NULL,
  "store_id" TEXT NOT NULL,
  "claim_id" TEXT NOT NULL,
  "receipt_id" TEXT NOT NULL,
  "state" TEXT NOT NULL DEFAULT 'pending_decision',
  "verdict" TEXT,
  "reasons" TEXT[],
  "amount_minor" INTEGER,
  "expected_amount_minor" INTEGER NOT NULL,
  "is_first_payment" BOOLEAN NOT NULL,
  "extracted_masked" JSONB,
  "idempotency_key" TEXT NOT NULL,
  "billing_event_id" TEXT,
  "confirmed_at" TIMESTAMP(3),
  "digest_sent_at" TIMESTAMP(3),
  "reverted_at" TIMESTAMP(3),
  "reverted_by" TEXT,
  "revert_reason" TEXT,
  "grace_until" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "instapay_auto_confirmations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "instapay_auto_confirmations_state_check" CHECK ("state" IN ('pending_decision', 'auto_confirmed', 'needs_human', 'reverted', 'failed'))
);
CREATE UNIQUE INDEX "instapay_auto_confirmations_claim_id_key" ON "instapay_auto_confirmations"("claim_id");
CREATE UNIQUE INDEX "instapay_auto_confirmations_idempotency_key_key" ON "instapay_auto_confirmations"("idempotency_key");
CREATE INDEX "instapay_auto_confirmations_store_id_created_at_idx" ON "instapay_auto_confirmations"("store_id", "created_at" DESC);
CREATE INDEX "instapay_auto_confirmations_state_digest_sent_at_idx" ON "instapay_auto_confirmations"("state", "digest_sent_at");
ALTER TABLE "instapay_auto_confirmations" ADD CONSTRAINT "instapay_auto_confirmations_store_id_fkey"
  FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE instapay_auto_confirmations ENABLE ROW LEVEL SECURITY;
ALTER TABLE instapay_auto_confirmations FORCE ROW LEVEL SECURITY;
CREATE POLICY ebda_tenant_isolation ON instapay_auto_confirmations AS PERMISSIVE FOR ALL TO ebda_app
  USING (store_id = nullif(current_setting('app.current_store_id', true), ''))
  WITH CHECK (store_id = nullif(current_setting('app.current_store_id', true), ''));
