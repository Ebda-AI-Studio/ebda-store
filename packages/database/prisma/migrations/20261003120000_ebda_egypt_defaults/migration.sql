-- Ebda (Egypt) regional defaults. FWB (Kuwait) defaulted to KWD / Asia/Kuwait /
-- "Kuwait". Ebda is EGP (integer piastres, 1 EGP = 100), Africa/Cairo, "Egypt".
--
-- DEFAULTS ONLY: Ebda has no production data, so no existing row is rewritten.
-- Old migrations are untouched (they are history); this one moves the column
-- defaults so every new row is Egyptian. Idempotent (SET DEFAULT can re-run).

ALTER TABLE "stores" ALTER COLUMN "currency" SET DEFAULT 'EGP';
ALTER TABLE "stores" ALTER COLUMN "timezone" SET DEFAULT 'Africa/Cairo';
ALTER TABLE "orders" ALTER COLUMN "currency" SET DEFAULT 'EGP';
ALTER TABLE "payments" ALTER COLUMN "currency" SET DEFAULT 'EGP';
ALTER TABLE "payment_configs" ALTER COLUMN "supported_currencies" SET DEFAULT ARRAY['EGP']::TEXT[];
ALTER TABLE "addresses" ALTER COLUMN "country" SET DEFAULT 'Egypt';
ALTER TABLE "shipping_area_rates" ALTER COLUMN "country" SET DEFAULT 'Egypt';
ALTER TABLE "shipping_area_rates" ALTER COLUMN "country_ar" SET DEFAULT 'مصر';
ALTER TABLE "journal_lines" ALTER COLUMN "currency" SET DEFAULT 'EGP';
ALTER TABLE "suppliers" ALTER COLUMN "default_currency" SET DEFAULT 'EGP';
ALTER TABLE "purchase_orders" ALTER COLUMN "currency" SET DEFAULT 'EGP';
ALTER TABLE "expenses" ALTER COLUMN "currency" SET DEFAULT 'EGP';

-- Money-valued default: FWB's 5 000 fils = 5 KWD minimum affiliate payout.
-- Re-based to 50 000 piastres = 500 EGP (placeholder — product to confirm).
ALTER TABLE "affiliate_configs" ALTER COLUMN "min_payout_amount" SET DEFAULT 50000;
