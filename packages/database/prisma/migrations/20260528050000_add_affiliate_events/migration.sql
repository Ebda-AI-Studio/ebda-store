-- Append-only audit trail for Affiliate status changes and financial events.
-- Mirrors the PaymentEvent pattern — rows are written once and never updated.
-- storeId is denormalized for efficient store-scoped admin queries without
-- joining back through the affiliates table.

CREATE TABLE "affiliate_events" (
    "id"                   TEXT         NOT NULL,
    "affiliate_id"         TEXT         NOT NULL,
    "store_id"             TEXT         NOT NULL,
    "event_type"           TEXT         NOT NULL,
    "from_status"          TEXT,
    "to_status"            TEXT,
    "triggered_by_user_id" TEXT,
    "details"              JSONB        NOT NULL DEFAULT '{}',
    "occurred_at"          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    "created_at"           TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

    CONSTRAINT "affiliate_events_pkey" PRIMARY KEY ("id")
);

-- FK: affiliate (cascade-delete rows when the affiliate is removed)
ALTER TABLE "affiliate_events"
    ADD CONSTRAINT "affiliate_events_affiliate_id_fkey"
    FOREIGN KEY ("affiliate_id") REFERENCES "affiliates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- FK: store (cascade-delete rows when the store is removed)
ALTER TABLE "affiliate_events"
    ADD CONSTRAINT "affiliate_events_store_id_fkey"
    FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- FK: triggering admin/user (set null when the user is deleted)
ALTER TABLE "affiliate_events"
    ADD CONSTRAINT "affiliate_events_triggered_by_user_id_fkey"
    FOREIGN KEY ("triggered_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Composite: timeline per affiliate (common read pattern: show history for one affiliate)
CREATE INDEX "affiliate_events_affiliate_id_occurred_at_idx"
    ON "affiliate_events"("affiliate_id", "occurred_at");

-- Composite: timeline per store, newest-first (admin overview dashboard)
CREATE INDEX "affiliate_events_store_id_occurred_at_idx"
    ON "affiliate_events"("store_id", "occurred_at" DESC);

-- Single-column: filter or aggregate by event type
CREATE INDEX "affiliate_events_event_type_idx"
    ON "affiliate_events"("event_type");
