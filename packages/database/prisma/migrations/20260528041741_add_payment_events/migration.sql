-- Add append-only payment_events table to close the audit gap on
-- payments. See packages/database/prisma/schema.prisma → PaymentEvent
-- model + apps/api/src/services/payment-event.service.ts for usage.

CREATE TABLE "payment_events" (
    "id" TEXT NOT NULL,
    "payment_id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "from_status" "PaymentStatus",
    "to_status" "PaymentStatus",
    "provider" TEXT,
    "provider_payload" JSONB,
    "details" JSONB NOT NULL DEFAULT '{}'::jsonb,
    "triggered_by_user_id" TEXT,
    "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "payment_events_payment_id_occurred_at_idx"
    ON "payment_events"("payment_id", "occurred_at");

CREATE INDEX "payment_events_store_id_occurred_at_idx"
    ON "payment_events"("store_id", "occurred_at" DESC);

CREATE INDEX "payment_events_order_id_occurred_at_idx"
    ON "payment_events"("order_id", "occurred_at");

CREATE INDEX "payment_events_event_type_idx"
    ON "payment_events"("event_type");

CREATE INDEX "payment_events_provider_occurred_at_idx"
    ON "payment_events"("provider", "occurred_at");

ALTER TABLE "payment_events"
    ADD CONSTRAINT "payment_events_payment_id_fkey"
    FOREIGN KEY ("payment_id") REFERENCES "payments"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "payment_events"
    ADD CONSTRAINT "payment_events_store_id_fkey"
    FOREIGN KEY ("store_id") REFERENCES "stores"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "payment_events"
    ADD CONSTRAINT "payment_events_triggered_by_user_id_fkey"
    FOREIGN KEY ("triggered_by_user_id") REFERENCES "users"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
