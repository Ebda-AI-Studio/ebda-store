-- SP5 task 3: EGP subscription billing — lifecycle columns, the append-only
-- billing ledger and the provider-webhook inbox.
--
-- A NEW migration (later timestamp) on purpose: it touches no earlier
-- migration, generator or RLS file. `billing_events` carries store-scoped RLS
-- in the same 4-policy shape as store_subscriptions (listed for the strict-RLS
-- sweep; written by system paths — cron, webhook — under app.bypass_rls).

ALTER TABLE "store_subscriptions"
  ADD COLUMN "billing_interval"  TEXT NOT NULL DEFAULT 'monthly',
  ADD COLUMN "pending_plan_code" TEXT,
  ADD COLUMN "dunning_attempts"  INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "next_retry_at"     TIMESTAMP(3);
ALTER TABLE "store_subscriptions"
  ADD CONSTRAINT "store_subscriptions_billing_interval_check"
  CHECK ("billing_interval" IN ('monthly', 'yearly'));
CREATE INDEX "store_subscriptions_current_period_end_idx" ON "store_subscriptions"("current_period_end");
CREATE INDEX "store_subscriptions_next_retry_at_idx" ON "store_subscriptions"("next_retry_at");

CREATE TABLE "billing_events" (
  "id"               TEXT NOT NULL,
  "store_id"         TEXT NOT NULL,
  "subscription_id"  TEXT,
  "type"             TEXT NOT NULL,
  "plan_code"        TEXT,
  "billing_interval" TEXT,
  "for_period_end"   TIMESTAMP(3),
  "attempt"          INTEGER NOT NULL DEFAULT 0,
  "amount_minor"     INTEGER NOT NULL,
  "currency"         TEXT NOT NULL DEFAULT 'EGP',
  "provider"         TEXT NOT NULL,
  "provider_ref"     TEXT,
  "idempotency_key"  TEXT NOT NULL,
  "status"           TEXT NOT NULL DEFAULT 'pending',
  "failure_reason"   TEXT,
  "related_event_id" TEXT,
  "raw"              JSONB,
  "created_at"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "billing_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "billing_events_amount_check" CHECK ("amount_minor" >= 0),
  CONSTRAINT "billing_events_type_check" CHECK ("type" IN ('checkout', 'renewal', 'upgrade', 'refund')),
  CONSTRAINT "billing_events_status_check" CHECK ("status" IN ('pending', 'succeeded', 'failed', 'refunded'))
);
CREATE UNIQUE INDEX "billing_events_idempotency_key_key" ON "billing_events"("idempotency_key");
CREATE INDEX "billing_events_store_id_created_at_idx" ON "billing_events"("store_id", "created_at" DESC);
CREATE INDEX "billing_events_status_created_at_idx" ON "billing_events"("status", "created_at");
CREATE INDEX "billing_events_provider_provider_ref_idx" ON "billing_events"("provider", "provider_ref");
ALTER TABLE "billing_events"
  ADD CONSTRAINT "billing_events_store_id_fkey"
  FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Append-only: no direct deletes (store cascade still allowed); the money columns and identity never change; a
-- settled `succeeded` charge can only move to `refunded` (a late "failed"
-- webhook cannot overwrite it — defence in depth under the service's guard).
CREATE OR REPLACE FUNCTION billing_events_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- Depth 1 = a direct DELETE; depth 2 = the stores(id) ON DELETE CASCADE
    -- action, which must keep working (store removal / erasure).
    IF pg_trigger_depth() <= 1 THEN
      RAISE EXCEPTION 'billing_events is append-only (delete refused)';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW."store_id" IS DISTINCT FROM OLD."store_id"
     OR NEW."type" IS DISTINCT FROM OLD."type"
     OR NEW."amount_minor" IS DISTINCT FROM OLD."amount_minor"
     OR NEW."currency" IS DISTINCT FROM OLD."currency"
     OR NEW."provider" IS DISTINCT FROM OLD."provider"
     OR NEW."idempotency_key" IS DISTINCT FROM OLD."idempotency_key"
     OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
    RAISE EXCEPTION 'billing_events is append-only (immutable column changed)';
  END IF;
  IF OLD."status" = 'succeeded' AND NEW."status" NOT IN ('succeeded', 'refunded') THEN
    RAISE EXCEPTION 'billing_events: a succeeded charge cannot become %', NEW."status";
  END IF;
  IF OLD."status" = 'refunded' AND NEW."status" <> 'refunded' THEN
    RAISE EXCEPTION 'billing_events: a refunded charge cannot become %', NEW."status";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "billing_events_guard_update" BEFORE UPDATE ON "billing_events"
  FOR EACH ROW EXECUTE FUNCTION billing_events_guard();
CREATE TRIGGER "billing_events_guard_delete" BEFORE DELETE ON "billing_events"
  FOR EACH ROW EXECUTE FUNCTION billing_events_guard();

CREATE TABLE "billing_webhook_events" (
  "id"          TEXT NOT NULL,
  "provider"    TEXT NOT NULL,
  "event_id"    TEXT NOT NULL,
  "event_type"  TEXT NOT NULL,
  "outcome"     TEXT NOT NULL,
  "detail"      TEXT,
  "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "billing_webhook_events_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "billing_webhook_events_provider_event_id_key"
  ON "billing_webhook_events"("provider", "event_id");

ALTER TABLE "billing_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "billing_events" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "billing_events_app_select" ON "billing_events";
CREATE POLICY "billing_events_app_select" ON "billing_events" FOR SELECT
  USING (current_store_id() IS NULL OR current_setting('app.bypass_rls', true) = 'true' OR store_id = current_store_id());

DROP POLICY IF EXISTS "billing_events_app_insert" ON "billing_events";
CREATE POLICY "billing_events_app_insert" ON "billing_events" FOR INSERT
  WITH CHECK (current_store_id() IS NULL OR current_setting('app.bypass_rls', true) = 'true' OR store_id = current_store_id());

DROP POLICY IF EXISTS "billing_events_app_update" ON "billing_events";
CREATE POLICY "billing_events_app_update" ON "billing_events" FOR UPDATE
  USING (current_store_id() IS NULL OR current_setting('app.bypass_rls', true) = 'true' OR store_id = current_store_id())
  WITH CHECK (current_store_id() IS NULL OR current_setting('app.bypass_rls', true) = 'true' OR store_id = current_store_id());

-- No DELETE policy for the app: with FORCE RLS a delete matches no rows.
