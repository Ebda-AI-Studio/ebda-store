-- Hand-written. billing_events is append-only (20261003150000_billing_events_and_dunning). D1 supports triggers.
-- A direct DELETE aborts; the delete that cascades from removing the store row is allowed (the parent row
-- is already gone when the cascade fires, so `EXISTS (parent)` distinguishes the two).
CREATE TRIGGER IF NOT EXISTS "billing_events_guard_delete" BEFORE DELETE ON "billing_events"
WHEN EXISTS (SELECT 1 FROM "stores" WHERE "id" = OLD."store_id")
BEGIN
  SELECT RAISE(ABORT, 'billing_events is append-only (delete refused)');
END;

CREATE TRIGGER IF NOT EXISTS "billing_events_guard_update" BEFORE UPDATE ON "billing_events"
WHEN NEW."store_id" IS NOT OLD."store_id"
  OR NEW."type" IS NOT OLD."type"
  OR NEW."amount_minor" IS NOT OLD."amount_minor"
  OR NEW."currency" IS NOT OLD."currency"
  OR NEW."provider" IS NOT OLD."provider"
  OR NEW."idempotency_key" IS NOT OLD."idempotency_key"
  OR NEW."created_at" IS NOT OLD."created_at"
BEGIN
  SELECT RAISE(ABORT, 'billing_events is append-only (immutable column changed)');
END;

CREATE TRIGGER IF NOT EXISTS "billing_events_succeeded_final" BEFORE UPDATE OF "status" ON "billing_events"
WHEN OLD."status" = 'succeeded' AND NEW."status" NOT IN ('succeeded', 'refunded')
BEGIN
  SELECT RAISE(ABORT, 'billing_events: a succeeded charge can only become refunded');
END;

CREATE TRIGGER IF NOT EXISTS "billing_events_refunded_final" BEFORE UPDATE OF "status" ON "billing_events"
WHEN OLD."status" = 'refunded' AND NEW."status" <> 'refunded'
BEGIN
  SELECT RAISE(ABORT, 'billing_events: a refunded charge is final');
END;

-- billing_grants is an append-only ledger of free months (FOUNDING-1/3, 20261105000500). No store_id: no cascade
-- exception. Allowed: pending -> applied | revoked, applied -> revoked, and a revoked grant gets `restored_at` once.
CREATE TRIGGER IF NOT EXISTS "billing_grants_guard_delete" BEFORE DELETE ON "billing_grants"
BEGIN
  SELECT RAISE(ABORT, 'billing_grants is append-only (delete refused)');
END;

CREATE TRIGGER IF NOT EXISTS "billing_grants_guard_update" BEFORE UPDATE ON "billing_grants"
WHEN NEW."kind" IS NOT OLD."kind"
  OR NEW."beneficiary_id" IS NOT OLD."beneficiary_id"
  OR NEW."counterpart_id" IS NOT OLD."counterpart_id"
  OR NEW."months" IS NOT OLD."months"
  OR NEW."value_minor" IS NOT OLD."value_minor"
  OR NEW."source_event_id" IS NOT OLD."source_event_id"
  OR NEW."source_store_id" IS NOT OLD."source_store_id"
  OR NEW."idempotency_key" IS NOT OLD."idempotency_key"
  OR NEW."created_at" IS NOT OLD."created_at"
  OR (OLD."status" = 'applied' AND (
        NEW."status" NOT IN ('applied', 'revoked')
        OR NEW."period_end_before" IS NOT OLD."period_end_before"
        OR NEW."period_end_after" IS NOT OLD."period_end_after"
        OR NEW."applied_at" IS NOT OLD."applied_at"))
  OR (OLD."status" = 'revoked' AND (
        NEW."status" <> 'revoked'
        OR NEW."revoked_at" IS NOT OLD."revoked_at"
        OR NEW."revoke_reason" IS NOT OLD."revoke_reason"
        OR NEW."period_end_before" IS NOT OLD."period_end_before"
        OR NEW."period_end_after" IS NOT OLD."period_end_after"
        OR NEW."applied_at" IS NOT OLD."applied_at"
        OR (OLD."restored_at" IS NOT NULL AND NEW."restored_at" IS NOT OLD."restored_at")))
BEGIN
  SELECT RAISE(ABORT, 'billing_grants is append-only (immutable, final or invalid move)');
END;
