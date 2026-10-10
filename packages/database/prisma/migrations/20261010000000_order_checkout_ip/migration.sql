-- Stock-hold abuse fix (open unpaid order cap). EXPAND ONLY: one new nullable
-- column + supporting indexes, nothing existing is altered or dropped.
--
-- `orders.checkout_ip` records the server-observed client IP at order-creation
-- time (never client-supplied). It backs `lib/stock-hold-cap.ts`, which rejects
-- a new COD/InstaPay order once the same phone, email OR IP already has too
-- many open (pending / awaiting_payment_confirmation, unpaid) orders — closing
-- the gap where guest checkout had no cap on concurrent unpaid stock holds for
-- the two payment methods that never capture synchronously and (COD) are
-- deliberately excluded from the 2-day auto-cancel sweep (ruling MONEYB-7).
-- NULL for every pre-existing order and for non-HTTP order creation (admin
-- manual orders, scripts) — the cap check treats a NULL ip as "no ip signal",
-- same as it already does for a guest with no phone/email.
ALTER TABLE "orders" ADD COLUMN "checkout_ip" TEXT;

-- The cap check's count query ORs across phone/email/checkout_ip and runs on
-- EVERY cod/instapay checkout — unlike the similarly-shaped (and similarly
-- unindexed) per-user coupon-limit check elsewhere in this file, which only
-- runs when a coupon with usageLimitPerUser is actually applied. For a
-- COD-heavy store, `store_id + status` is NOT selective: COD orders never
-- auto-cancel (ruling MONEYB-7), so "open COD orders" can be most of the
-- store's history. Measured on 50k open orders for one store: a plain
-- `(store_id, checkout_ip)` index still forced a sequential scan (~30ms,
-- because the JSON-path phone/email branches of the OR have no index at
-- all) — these three PARTIAL expression indexes, scoped to exactly the "open
-- hold" predicate the app query uses, let the planner answer with a
-- BitmapOr instead (~1.4ms on the same data) and stay small regardless of
-- how large the store's RESOLVED order history grows, because a row drops
-- out of each index the moment it leaves this predicate (paid/cancelled/
-- refunded). Prisma's schema DSL has no partial/expression `@@index`, so —
-- same precedent as `orders_order_number_trgm_idx`
-- (20261002090000_order_search_trgm_and_fk_indexes) — these live in raw SQL
-- only; not declared in schema.prisma.
CREATE INDEX IF NOT EXISTS "orders_open_hold_phone_idx"
  ON "orders" ("store_id", (shipping_address #>> '{phone}'))
  WHERE "status" IN ('pending', 'awaiting_payment_confirmation')
    AND "payment_status" = 'unpaid'
    AND "deleted_at" IS NULL;

CREATE INDEX IF NOT EXISTS "orders_open_hold_email_idx"
  ON "orders" ("store_id", (shipping_address #>> '{email}'))
  WHERE "status" IN ('pending', 'awaiting_payment_confirmation')
    AND "payment_status" = 'unpaid'
    AND "deleted_at" IS NULL;

CREATE INDEX IF NOT EXISTS "orders_open_hold_ip_idx"
  ON "orders" ("store_id", "checkout_ip")
  WHERE "status" IN ('pending', 'awaiting_payment_confirmation')
    AND "payment_status" = 'unpaid'
    AND "deleted_at" IS NULL;
