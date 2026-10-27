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

