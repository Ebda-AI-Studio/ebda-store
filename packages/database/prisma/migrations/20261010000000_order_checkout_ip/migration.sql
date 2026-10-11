-- Stock-hold abuse fix (open unpaid order cap). EXPAND ONLY: two new
-- columns + supporting indexes, nothing existing is altered or dropped.
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
-- Legacy orders were not admitted atomically. Existing same-provider payment
-- retries remain supported; first manual attachment requires a fresh checkout.
ALTER TABLE "orders" ADD COLUMN "manual_hold_admitted" BOOLEAN NOT NULL DEFAULT false;

-- The transaction's two scalar counts filter contact identity (phone OR
-- canonical email) separately from checkout IP. These partial indexes match
-- each count's WHERE expression and open-hold predicate, so unrelated open
-- orders need not be scanned. They shrink as holds become paid/cancelled.
-- Prisma's DSL cannot express partial/expression indexes; keep them in SQL.
CREATE INDEX IF NOT EXISTS "orders_open_hold_phone_idx"
  ON "orders" ("store_id", (shipping_address #>> '{phone}'))
  WHERE "status" IN ('pending', 'awaiting_payment_confirmation')
    AND "payment_status" = 'unpaid'
    AND "deleted_at" IS NULL;

CREATE INDEX IF NOT EXISTS "orders_open_hold_email_idx"
  ON "orders" ("store_id", (lower(btrim(shipping_address #>> '{email}'))))
  WHERE "status" IN ('pending', 'awaiting_payment_confirmation')
    AND "payment_status" = 'unpaid'
    AND "deleted_at" IS NULL;

CREATE INDEX IF NOT EXISTS "orders_open_hold_ip_idx"
  ON "orders" ("store_id", "checkout_ip")
  WHERE "status" IN ('pending', 'awaiting_payment_confirmation')
    AND "payment_status" = 'unpaid'
    AND "deleted_at" IS NULL;
