-- Stock-hold abuse fix (open unpaid order cap). EXPAND ONLY: one new nullable
-- column + one supporting index, nothing existing is altered or dropped.
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

CREATE INDEX IF NOT EXISTS "orders_store_id_checkout_ip_idx" ON "orders"("store_id", "checkout_ip");
