-- InstaPay receipts (money batch A, Rulings EBDA-MONEYA-1..): the transfer screenshot a payer
-- uploads (merchant paying Ebda's subscription, shopper paying a store order), what Gemini read
-- from it, what the payer submitted, the automatic flags, and the human review.
--
-- Additive only: one NEW store-scoped table. store_id => the single strict R-EBDA-001 policy.
-- reference_key is UNIQUE across every store (the hard duplicate block): a unique index is
-- enforced below RLS, so a reference used by ANOTHER store is refused even though that row is
-- invisible to this tenant. FK: store delete CASCADE (no NO ACTION child added).
-- The screenshot itself lives ONLY in the private bucket (storage_key); no URL column exists.
-- Rollback: DROP TABLE instapay_receipts (docs/ROLLBACK.md); private objects under
-- stores/<storeId>/instapay-receipts/ are then unreferenced and removed with the store prefix.

CREATE TABLE "instapay_receipts" (
    "id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "claim_id" TEXT,
    "order_id" TEXT,
    "payment_id" TEXT,
    "storage_key" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "extraction_status" TEXT NOT NULL DEFAULT 'pending',
    "extracted" JSONB,
    "confidence" DOUBLE PRECISION,
    "extraction_error" TEXT,
    "amount_minor" INTEGER,
    "reference" TEXT,
    "reference_key" TEXT,
    "transferred_at" TIMESTAMP(3),
    "payer_name" TEXT,
    "payer_address" TEXT,
    "payer_mobile" TEXT,
    "payer_bank" TEXT,
    "receiver_name" TEXT,
    "receiver_handle" TEXT,
    "receiver_mobile" TEXT,
    "note" TEXT,
    "expected_amount_minor" INTEGER,
    "expected_receiver" TEXT,
    "flags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" TEXT NOT NULL DEFAULT 'draft',
    "submitted_at" TIMESTAMP(3),
    "review_note" TEXT,
    "reviewed_by" TEXT,
    "reviewed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "instapay_receipts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "instapay_receipts_claim_id_key" ON "instapay_receipts"("claim_id");

CREATE UNIQUE INDEX "instapay_receipts_reference_key_key" ON "instapay_receipts"("reference_key");

CREATE INDEX "instapay_receipts_store_id_created_at_idx" ON "instapay_receipts"("store_id", "created_at" DESC);

CREATE INDEX "instapay_receipts_store_id_order_id_idx" ON "instapay_receipts"("store_id", "order_id");

CREATE INDEX "instapay_receipts_store_id_sha256_idx" ON "instapay_receipts"("store_id", "sha256");

ALTER TABLE "instapay_receipts" ADD CONSTRAINT "instapay_receipts_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "instapay_receipts" ADD CONSTRAINT "instapay_receipts_kind_check" CHECK ("kind" IN ('subscription', 'order'));
ALTER TABLE "instapay_receipts" ADD CONSTRAINT "instapay_receipts_status_check" CHECK ("status" IN ('draft', 'submitted', 'approved', 'rejected', 'voided'));
ALTER TABLE "instapay_receipts" ADD CONSTRAINT "instapay_receipts_extraction_check" CHECK ("extraction_status" IN ('pending', 'done', 'failed'));
ALTER TABLE "instapay_receipts" ADD CONSTRAINT "instapay_receipts_amount_check" CHECK ("amount_minor" IS NULL OR "amount_minor" > 0);
ALTER TABLE "instapay_receipts" ADD CONSTRAINT "instapay_receipts_size_check" CHECK ("size_bytes" > 0 AND "size_bytes" <= 10485760);

-- Strict tenant isolation (R-EBDA-001): the same single policy every store_id table carries.
ALTER TABLE instapay_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE instapay_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY ebda_tenant_isolation ON instapay_receipts AS PERMISSIVE FOR ALL TO ebda_app
  USING (store_id = nullif(current_setting('app.current_store_id', true), ''))
  WITH CHECK (store_id = nullif(current_setting('app.current_store_id', true), ''));
