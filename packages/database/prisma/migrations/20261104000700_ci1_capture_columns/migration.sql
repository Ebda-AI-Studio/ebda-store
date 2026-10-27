-- Customer Intelligence CI-1 (docs/plans/2026-10-28-customer-intelligence.md 1.1): the capture columns that
-- cannot be rebuilt later. Additive only; every existing row keeps working (all nullable or defaulted).
-- Existing tables already carry their strict RLS policies, so nothing to add there.

ALTER TABLE "shipments"
  ADD COLUMN "picked_up_at" TIMESTAMP(3),
  ADD COLUMN "delivered_at" TIMESTAMP(3),
  ADD COLUMN "returned_at" TIMESTAMP(3),
  ADD COLUMN "delivery_attempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "return_reason_raw" TEXT,
  ADD COLUMN "return_reason_code" TEXT,
  ADD COLUMN "area_key" TEXT;

ALTER TABLE "shipments" ADD CONSTRAINT "shipments_return_reason_code_check" CHECK (
  "return_reason_code" IS NULL OR "return_reason_code" IN (
    'customer_refused', 'customer_unreachable', 'wrong_address', 'address_incomplete',
    'customer_postponed', 'price_dispute', 'product_not_as_described', 'damaged_in_transit',
    'courier_failed_attempts', 'courier_lost', 'duplicate_order', 'fake_order', 'other'
  )
);
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_return_reason_raw_len_check" CHECK (
  "return_reason_raw" IS NULL OR char_length("return_reason_raw") <= 200
);
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_delivery_attempts_check" CHECK ("delivery_attempts" >= 0);

ALTER TABLE "orders"
  ADD COLUMN "area_key" TEXT,
  ADD COLUMN "buyer_key" TEXT;
ALTER TABLE "orders" ADD CONSTRAINT "orders_buyer_key_check" CHECK ("buyer_key" IS NULL OR "buyer_key" ~ '^[0-9a-f]{64}$');

ALTER TABLE "stores"
  ADD COLUMN "ci_sharing" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "ci_sharing_changed_at" TIMESTAMP(3);

-- "first order by this buyer in this store" is a point count on (store, buyer); partial: most orders have a key only after CI stamps it.
CREATE INDEX "orders_store_buyer_key_created_idx" ON "orders"("store_id", "buyer_key", "created_at") WHERE "buyer_key" IS NOT NULL;
