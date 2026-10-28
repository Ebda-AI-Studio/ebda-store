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
  "source_event_id"   TEXT,
  "source_store_id"   TEXT,
  "revoked_at"        TIMESTAMP(3),
  "revoke_reason"     TEXT,
  "restored_at"       TIMESTAMP(3),
  "idempotency_key"   TEXT NOT NULL,
  "period_end_before" TIMESTAMP(3),
  "period_end_after"  TIMESTAMP(3),
  "applied_at"        TIMESTAMP(3),
  "created_at"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "billing_grants_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "billing_grants_kind_check" CHECK ("kind" IN ('founding', 'referral_referrer', 'referral_referred')),
  CONSTRAINT "billing_grants_status_check" CHECK ("status" IN ('pending', 'applied', 'revoked')),
  CONSTRAINT "billing_grants_months_check" CHECK ("months" = 1),
  CONSTRAINT "billing_grants_value_check" CHECK ("value_minor" >= 0)
);
CREATE UNIQUE INDEX "billing_grants_idempotency_key_key" ON "billing_grants"("idempotency_key");
CREATE INDEX "billing_grants_beneficiary_id_status_idx" ON "billing_grants"("beneficiary_id", "status");
CREATE INDEX "billing_grants_kind_created_at_idx" ON "billing_grants"("kind", "created_at");
CREATE INDEX "billing_grants_source_event_id_idx" ON "billing_grants"("source_event_id");
CREATE INDEX "billing_grants_source_store_id_status_idx" ON "billing_grants"("source_store_id", "status");

-- Append-only: no deletes; identity, source and money columns never change. Allowed moves: pending -> applied (with the
-- period bookkeeping) | revoked; applied -> revoked; a revoked grant may only get `restored_at` set once.
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
     OR NEW."source_event_id" IS DISTINCT FROM OLD."source_event_id"
     OR NEW."source_store_id" IS DISTINCT FROM OLD."source_store_id"
     OR NEW."idempotency_key" IS DISTINCT FROM OLD."idempotency_key"
     OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
    RAISE EXCEPTION 'billing_grants is append-only (immutable column changed)';
  END IF;
  -- every move is checked, whatever the old state
  IF NEW."status" = 'revoked' AND (NEW."revoked_at" IS NULL OR NEW."revoke_reason" IS NULL) THEN
    RAISE EXCEPTION 'billing_grants: a revoked grant needs revoked_at and revoke_reason';
  END IF;
  IF NEW."status" <> 'revoked' AND (NEW."revoked_at" IS NOT NULL OR NEW."restored_at" IS NOT NULL) THEN
    RAISE EXCEPTION 'billing_grants: revoked_at / restored_at belong to a revoked grant only';
  END IF;
  IF NEW."status" = 'applied' AND (NEW."applied_at" IS NULL OR NEW."period_end_before" IS NULL OR NEW."period_end_after" IS NULL) THEN
    RAISE EXCEPTION 'billing_grants: an applied grant needs its period bookkeeping';
  END IF;
  IF OLD."status" = 'pending' THEN
    IF NEW."status" = 'revoked' AND (NEW."restored_at" IS NOT NULL OR NEW."applied_at" IS NOT NULL
         OR NEW."period_end_before" IS NOT NULL OR NEW."period_end_after" IS NOT NULL) THEN
      RAISE EXCEPTION 'billing_grants: a pending grant is revoked without period bookkeeping';
    END IF;
    IF NEW."status" = 'pending' AND (NEW."applied_at" IS NOT NULL OR NEW."period_end_before" IS NOT NULL
         OR NEW."period_end_after" IS NOT NULL) THEN
      RAISE EXCEPTION 'billing_grants: a pending grant has no period bookkeeping';
    END IF;
  ELSIF OLD."status" = 'applied' THEN
    IF NEW."status" NOT IN ('applied', 'revoked')
       OR NEW."period_end_before" IS DISTINCT FROM OLD."period_end_before"
       OR NEW."period_end_after" IS DISTINCT FROM OLD."period_end_after"
       OR NEW."applied_at" IS DISTINCT FROM OLD."applied_at"
       OR NEW."restored_at" IS NOT NULL THEN
      RAISE EXCEPTION 'billing_grants: an applied grant can only be revoked';
    END IF;
  ELSIF OLD."status" = 'revoked' THEN
    IF NEW."status" <> 'revoked'
       OR NEW."revoked_at" IS DISTINCT FROM OLD."revoked_at"
       OR NEW."revoke_reason" IS DISTINCT FROM OLD."revoke_reason"
       OR NEW."period_end_before" IS DISTINCT FROM OLD."period_end_before"
       OR NEW."period_end_after" IS DISTINCT FROM OLD."period_end_after"
       OR NEW."applied_at" IS DISTINCT FROM OLD."applied_at"
       OR (OLD."restored_at" IS NOT NULL AND NEW."restored_at" IS DISTINCT FROM OLD."restored_at") THEN
      RAISE EXCEPTION 'billing_grants: a revoked grant is final';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "billing_grants_guard_update" BEFORE UPDATE ON "billing_grants"
  FOR EACH ROW EXECUTE FUNCTION billing_grants_guard();
CREATE TRIGGER "billing_grants_guard_delete" BEFORE DELETE ON "billing_grants"
  FOR EACH ROW EXECUTE FUNCTION billing_grants_guard();
