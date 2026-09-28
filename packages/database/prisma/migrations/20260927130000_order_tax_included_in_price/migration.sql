-- Ruling M3-7 follow-up: record on the ORDER whether its listed prices already
-- contained the VAT, so every `orders.tax` consumer reads the money the way it
-- was charged instead of re-deriving it from the mutable
-- `stores.tax_included_in_price` switch.
--
-- Additive and constant-defaulted (no table rewrite on PG11+). `false` is the
-- exclusive convention every existing order was charged under — and no live
-- store has inclusive VAT with an active rate today (ruling M3-7) — so this
-- backfills to exactly what every consumer already assumed and nothing
-- existing changes.

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "tax_included_in_price" BOOLEAN NOT NULL DEFAULT false;
