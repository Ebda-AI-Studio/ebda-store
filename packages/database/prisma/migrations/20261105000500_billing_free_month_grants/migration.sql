-- FOUNDING-1 (M-082): founding-20 + referral free months. Two platform tables (no store_id, no RLS, same
-- class as billing_webhook_events): the referral link and an append-only grant ledger.
CREATE TABLE "billing_referrals" (
  "referred_store_id" TEXT NOT NULL,
  "referrer_store_id" TEXT NOT NULL,
  "created_at"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "billing_referrals_pkey" PRIMARY KEY ("referred_store_id"),
  CONSTRAINT "billing_referrals_not_self" CHECK ("referred_store_id" <> "referrer_store_id")
);
CREATE INDEX "billing_referrals_referrer_store_id_idx" ON "billing_referrals"("referrer_store_id");

CREATE TABLE "billing_grants" (
  "id"                TEXT NOT NULL,
  "kind"              TEXT NOT NULL,
  "beneficiary_id"    TEXT NOT NULL,
  "counterpart_id"    TEXT,
  "months"            INTEGER NOT NULL DEFAULT 1,
  "value_minor"       INTEGER NOT NULL DEFAULT 0,
  "status"            TEXT NOT NULL DEFAULT 'pending',
  "idempotency_key"   TEXT NOT NULL,
  "period_end_before" TIMESTAMP(3),
  "period_end_after"  TIMESTAMP(3),
  "applied_at"        TIMESTAMP(3),
  "created_at"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "billing_grants_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "billing_grants_kind_check" CHECK ("kind" IN ('founding', 'referral_referrer', 'referral_referred')),
  CONSTRAINT "billing_grants_status_check" CHECK ("status" IN ('pending', 'applied')),
  CONSTRAINT "billing_grants_months_check" CHECK ("months" = 1),
  CONSTRAINT "billing_grants_value_check" CHECK ("value_minor" >= 0)
);
CREATE UNIQUE INDEX "billing_grants_idempotency_key_key" ON "billing_grants"("idempotency_key");
CREATE INDEX "billing_grants_beneficiary_id_status_idx" ON "billing_grants"("beneficiary_id", "status");
CREATE INDEX "billing_grants_kind_created_at_idx" ON "billing_grants"("kind", "created_at");

-- Append-only: no deletes; identity and money columns never change; only pending -> applied (with the period
-- bookkeeping) is allowed, and an applied grant is final.
CREATE OR REPLACE FUNCTION billing_grants_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'billing_grants is append-only (delete refused)';
  END IF;
  IF NEW."kind" IS DISTINCT FROM OLD."kind"
     OR NEW."beneficiary_id" IS DISTINCT FROM OLD."beneficiary_id"
     OR NEW."counterpart_id" IS DISTINCT FROM OLD."counterpart_id"
     OR NEW."months" IS DISTINCT FROM OLD."months"
     OR NEW."value_minor" IS DISTINCT FROM OLD."value_minor"
     OR NEW."idempotency_key" IS DISTINCT FROM OLD."idempotency_key"
     OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
    RAISE EXCEPTION 'billing_grants is append-only (immutable column changed)';
  END IF;
  IF OLD."status" = 'applied' THEN
    RAISE EXCEPTION 'billing_grants: an applied grant is final';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "billing_grants_guard_update" BEFORE UPDATE ON "billing_grants"
  FOR EACH ROW EXECUTE FUNCTION billing_grants_guard();
CREATE TRIGGER "billing_grants_guard_delete" BEFORE DELETE ON "billing_grants"
  FOR EACH ROW EXECUTE FUNCTION billing_grants_guard();
