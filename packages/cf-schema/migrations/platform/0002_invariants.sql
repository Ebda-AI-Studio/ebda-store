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

-- WA-GRACE-1 (Postgres: store_subscriptions_past_due_since). `past_due_since` (epoch ms) is the first time
-- the subscription went past_due: set once on the transition into past_due, kept on a retry that stays
-- past_due, cleared on any other status. Ebda WhatsApp ends its grace at min(periodEnd, pastDueSince + 7 d).
CREATE TRIGGER IF NOT EXISTS "store_subscriptions_past_due_since_insert" AFTER INSERT ON "store_subscriptions"
WHEN NEW."status" = 'past_due' AND NEW."past_due_since" IS NULL
BEGIN
  UPDATE "store_subscriptions" SET "past_due_since" = CAST(unixepoch('subsec') * 1000 AS INTEGER) WHERE "id" = NEW."id";
END;

CREATE TRIGGER IF NOT EXISTS "store_subscriptions_past_due_since_update" AFTER UPDATE OF "status" ON "store_subscriptions"
WHEN NEW."status" = 'past_due' AND (OLD."status" <> 'past_due' OR OLD."past_due_since" IS NULL)
BEGIN
  UPDATE "store_subscriptions" SET "past_due_since" = COALESCE(NEW."past_due_since", CAST(unixepoch('subsec') * 1000 AS INTEGER)) WHERE "id" = NEW."id";
END;

CREATE TRIGGER IF NOT EXISTS "store_subscriptions_past_due_since_clear" AFTER UPDATE OF "status" ON "store_subscriptions"
WHEN NEW."status" <> 'past_due' AND NEW."past_due_since" IS NOT NULL
BEGIN
  UPDATE "store_subscriptions" SET "past_due_since" = NULL WHERE "id" = NEW."id";
END;


-- billing_grants is append-only (FOUNDING-1, Ruling CF-SCHEMA-GRANTS-1, ported INFRA-CF-1 D2b-5, Ruling CF-LAST-2). The same
-- refusals as the Postgres billing_grants_guard(), one statement per rule: no deletes (not even a cascade: grants have no
-- parent FK), identity / source / money columns never change, every move is checked whatever the old state, and the allowed
-- moves are pending -> applied | revoked, applied -> revoked, a revoked grant gets `restored_at` set once.
CREATE TRIGGER IF NOT EXISTS "billing_grants_guard_delete" BEFORE DELETE ON "billing_grants"
BEGIN
  SELECT RAISE(ABORT, 'billing_grants is append-only (delete refused)');
END;

CREATE TRIGGER IF NOT EXISTS "billing_grants_guard_update" BEFORE UPDATE ON "billing_grants"
BEGIN
  SELECT RAISE(ABORT, 'billing_grants is append-only (immutable column changed)')
  WHERE NEW."kind" IS NOT OLD."kind"
     OR NEW."beneficiary_id" IS NOT OLD."beneficiary_id"
     OR NEW."counterpart_id" IS NOT OLD."counterpart_id"
     OR NEW."months" IS NOT OLD."months"
     OR NEW."value_minor" IS NOT OLD."value_minor"
     OR NEW."source_event_id" IS NOT OLD."source_event_id"
     OR NEW."source_store_id" IS NOT OLD."source_store_id"
     OR NEW."idempotency_key" IS NOT OLD."idempotency_key"
     OR NEW."created_at" IS NOT OLD."created_at";
  SELECT RAISE(ABORT, 'billing_grants: a revoked grant needs revoked_at and revoke_reason')
  WHERE NEW."status" = 'revoked' AND (NEW."revoked_at" IS NULL OR NEW."revoke_reason" IS NULL);
  SELECT RAISE(ABORT, 'billing_grants: revoked_at / restored_at belong to a revoked grant only')
  WHERE NEW."status" <> 'revoked' AND (NEW."revoked_at" IS NOT NULL OR NEW."restored_at" IS NOT NULL);
  SELECT RAISE(ABORT, 'billing_grants: an applied grant needs its period bookkeeping')
  WHERE NEW."status" = 'applied'
    AND (NEW."applied_at" IS NULL OR NEW."period_end_before" IS NULL OR NEW."period_end_after" IS NULL);
  SELECT RAISE(ABORT, 'billing_grants: a pending grant is revoked without period bookkeeping')
  WHERE OLD."status" = 'pending' AND NEW."status" = 'revoked'
    AND (NEW."restored_at" IS NOT NULL OR NEW."applied_at" IS NOT NULL
         OR NEW."period_end_before" IS NOT NULL OR NEW."period_end_after" IS NOT NULL);
  SELECT RAISE(ABORT, 'billing_grants: a pending grant has no period bookkeeping')
  WHERE OLD."status" = 'pending' AND NEW."status" = 'pending'
    AND (NEW."applied_at" IS NOT NULL OR NEW."period_end_before" IS NOT NULL OR NEW."period_end_after" IS NOT NULL);
  SELECT RAISE(ABORT, 'billing_grants: an applied grant can only be revoked')
  WHERE OLD."status" = 'applied'
    AND (NEW."status" NOT IN ('applied', 'revoked')
         OR NEW."period_end_before" IS NOT OLD."period_end_before"
         OR NEW."period_end_after" IS NOT OLD."period_end_after"
         OR NEW."applied_at" IS NOT OLD."applied_at"
         OR NEW."restored_at" IS NOT NULL);
  SELECT RAISE(ABORT, 'billing_grants: a revoked grant is final')
  WHERE OLD."status" = 'revoked'
    AND (NEW."status" <> 'revoked'
         OR NEW."revoked_at" IS NOT OLD."revoked_at"
         OR NEW."revoke_reason" IS NOT OLD."revoke_reason"
         OR NEW."period_end_before" IS NOT OLD."period_end_before"
         OR NEW."period_end_after" IS NOT OLD."period_end_after"
         OR NEW."applied_at" IS NOT OLD."applied_at"
         OR (OLD."restored_at" IS NOT NULL AND NEW."restored_at" IS NOT OLD."restored_at"));
END;
