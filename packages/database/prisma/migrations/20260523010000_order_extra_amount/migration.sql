-- Adds Order.extra_amount + extra_amount_note for merchant-initiated
-- payment links that include an "out-of-catalog" charge (custom quote,
-- service fee, deposit) on top of catalogued items. Stored in fils,
-- same scale as Order.total. Default 0 + nullable note keeps the
-- change zero-downtime; existing rows are unaffected.
--
-- The payment webhook still compares paid amount to Order.total — that
-- value already includes extra_amount (route code sums it on insert),
-- so MyFatoorah callback flow needs no schema awareness. Order detail
-- UI can render the extra_amount + note as a synthetic line item
-- alongside actual OrderItems.

ALTER TABLE "orders"
  ADD COLUMN IF NOT EXISTS "extra_amount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "extra_amount_note" TEXT;
