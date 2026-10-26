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

-- billing_grants is an append-only ledger of free months (FOUNDING-1, 20261105000500). No store_id: no cascade
-- exception. Only pending -> applied (with the period bookkeeping) may change; an applied grant is final.
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
  OR NEW."idempotency_key" IS NOT OLD."idempotency_key"
  OR NEW."created_at" IS NOT OLD."created_at"
  OR OLD."status" = 'applied'
BEGIN
  SELECT RAISE(ABORT, 'billing_grants is append-only (immutable or applied)');
END;
