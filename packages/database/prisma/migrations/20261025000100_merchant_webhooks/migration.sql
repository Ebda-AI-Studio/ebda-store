-- Merchant OUTGOING webhooks (docs/plans/2026-10-21-merchant-webhooks.md).
--
--   webhook_endpoints    NEW, store-scoped. URL + subscribed events + encrypted HMAC secret.
--   webhook_deliveries   NEW, store-scoped. One signed event per endpoint; payload kept so a
--                        resend is byte-identical. Customer contact is in the payload ONLY when
--                        the endpoint has include_customer = true (default false).
--
-- Viewer: admin /stores/[id]/webhooks. Retention: last 50 per endpoint + 30-day purge (Inngest
-- webhook-delivery-purge-daily). Store delete CASCADEs both tables; no NO ACTION child.
-- Customer erasure: payloads carry no customer identity unless the merchant opted in; the 30-day
-- purge bounds that copy.
-- Lock note: two new empty tables, additive only; brief SHARE ROW EXCLUSIVE on "stores" while the
-- FK is added.
-- Rollback: rollback.sql (DROP both tables; loses only endpoint config and the delivery log).

-- CreateTable
CREATE TABLE "webhook_endpoints" (
    "id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "url" VARCHAR(2048) NOT NULL,
    "description" VARCHAR(120),
    "events" TEXT[],
    "include_customer" BOOLEAN NOT NULL DEFAULT false,
    "secret_enc" TEXT NOT NULL,
    "secret_hint" VARCHAR(8) NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "disabled_reason" VARCHAR(40),
    "disabled_at" TIMESTAMP(3),
    "consecutive_failures" INTEGER NOT NULL DEFAULT 0,
    "last_success_at" TIMESTAMP(3),
    "last_failure_at" TIMESTAMP(3),
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "webhook_endpoints_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_deliveries" (
    "id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "endpoint_id" TEXT NOT NULL,
    "event_id" VARCHAR(64) NOT NULL,
    "event_type" VARCHAR(40) NOT NULL,
    "dedupe_key" VARCHAR(160),
    "payload" JSONB NOT NULL,
    "status" VARCHAR(12) NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "is_test" BOOLEAN NOT NULL DEFAULT false,
    "response_status" INTEGER,
    "response_snippet" VARCHAR(200),
    "error" VARCHAR(200),
    "duration_ms" INTEGER,
    "next_attempt_at" TIMESTAMP(3),
    "delivered_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "webhook_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "webhook_endpoints_id_store_id_key" ON "webhook_endpoints"("id", "store_id");

-- CreateIndex
CREATE INDEX "webhook_endpoints_store_id_created_at_idx" ON "webhook_endpoints"("store_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "webhook_deliveries_endpoint_id_dedupe_key_key" ON "webhook_deliveries"("endpoint_id", "dedupe_key");

-- CreateIndex
CREATE INDEX "webhook_deliveries_endpoint_id_created_at_idx" ON "webhook_deliveries"("endpoint_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "webhook_deliveries_store_id_created_at_idx" ON "webhook_deliveries"("store_id", "created_at");

-- AddForeignKey
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey (composite: a delivery can only point at an endpoint of its OWN store)
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_endpoint_id_store_id_fkey" FOREIGN KEY ("endpoint_id", "store_id") REFERENCES "webhook_endpoints"("id", "store_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Strict tenant isolation (R-EBDA-001): the same single policy every store_id table carries.
ALTER TABLE webhook_endpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_endpoints FORCE ROW LEVEL SECURITY;
CREATE POLICY ebda_tenant_isolation ON webhook_endpoints AS PERMISSIVE FOR ALL TO ebda_app
  USING (store_id = nullif(current_setting('app.current_store_id', true), ''))
  WITH CHECK (store_id = nullif(current_setting('app.current_store_id', true), ''));
GRANT SELECT, INSERT, UPDATE, DELETE ON webhook_endpoints TO ebda_app;

ALTER TABLE webhook_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_deliveries FORCE ROW LEVEL SECURITY;
CREATE POLICY ebda_tenant_isolation ON webhook_deliveries AS PERMISSIVE FOR ALL TO ebda_app
  USING (store_id = nullif(current_setting('app.current_store_id', true), ''))
  WITH CHECK (store_id = nullif(current_setting('app.current_store_id', true), ''));
GRANT SELECT, INSERT, UPDATE, DELETE ON webhook_deliveries TO ebda_app;
