-- Migration: 20260623120000_webhook_event_inbox
--
-- Transactional inbox for inbound payment-provider webhooks. The payment
-- webhook route now persists a row here, fires an Inngest event, and returns
-- 200 immediately — the heavy PaymentService.handleWebhook mutation runs in the
-- payment-webhook-process Inngest function, OFF the shared API request pool that
-- also serves auth/login. This removes the pool-starvation risk where a webhook
-- storm could hold every Prisma connection and time out login (P2024).
-- See feedback-db-pool-starvation-webhook-storm-starves-auth.md.
--
-- RLS: webhook_events is intentionally NOT a tenant-scoped table. It is
-- written/read cross-tenant (the route resolves store_id by querying payments,
-- and the Inngest consumer must read this row BEFORE it can enter tenant
-- context). All access goes through withRlsBypass, exactly like the existing
-- checkIdempotency / resolveStoreIdFromWebhookPayload helpers. No row-level
-- policy is added — store_id is informational here, not an isolation boundary.

CREATE TABLE IF NOT EXISTS "webhook_events" (
  "id"              TEXT NOT NULL,
  "provider"        TEXT NOT NULL,
  "idempotency_key" TEXT NOT NULL,
  "store_id"        TEXT,
  "payload"         JSONB NOT NULL,
  "raw_body"        TEXT NOT NULL,
  "signature"       TEXT NOT NULL,
  "status"          TEXT NOT NULL DEFAULT 'received',
  "attempts"        INTEGER NOT NULL DEFAULT 0,
  "last_error"      TEXT,
  "result_order_id" TEXT,
  "result_status"   TEXT,
  "received_at"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "processed_at"    TIMESTAMP(3),
  "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "webhook_events_pkey" PRIMARY KEY ("id")
);

-- UNIQUE: a duplicate provider delivery upserts onto the same inbox row
-- (idempotency layer 2 — see the route's checkIdempotency for layer 1).
CREATE UNIQUE INDEX IF NOT EXISTS "webhook_events_idempotency_key_key"
  ON "webhook_events" ("idempotency_key");

-- Supports a future replay sweep (WHERE status IN ('received','processing')
-- AND received_at < cutoff).
CREATE INDEX IF NOT EXISTS "webhook_events_status_received_at_idx"
  ON "webhook_events" ("status", "received_at");

CREATE INDEX IF NOT EXISTS "webhook_events_provider_received_at_idx"
  ON "webhook_events" ("provider", "received_at");

CREATE INDEX IF NOT EXISTS "webhook_events_store_id_received_at_idx"
  ON "webhook_events" ("store_id", "received_at" DESC);

-- store_id back-reference. ON DELETE SET NULL keeps the audit row if a store is
-- ever deleted (the webhook record outlives the tenant for dispute history).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'webhook_events_store_id_fkey'
  ) THEN
    ALTER TABLE "webhook_events"
      ADD CONSTRAINT "webhook_events_store_id_fkey"
      FOREIGN KEY ("store_id") REFERENCES "stores"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
