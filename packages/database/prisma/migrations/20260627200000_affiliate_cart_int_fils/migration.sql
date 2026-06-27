-- Migrate affiliate + abandoned-cart money columns from NUMERIC(12,3) to INTEGER (fils).
--
-- Data stored in each column and the conversion:
--
--   abandoned_carts.cart_total           — already fils (product.price × qty, Int × Int)
--                                          USING: ROUND(cart_total)::integer
--
--   abandoned_cart_configs.coupon_max_discount — stored as KWD decimal (e.g. 5.000 = 5 KWD)
--                                          USING: ROUND(coupon_max_discount * 1000)::integer
--
--   affiliates.total_earned              — fils (incremented by commissionAmount, Int fils)
--   affiliates.total_paid                — fils
--   affiliates.pending_balance           — fils
--                                          USING: ROUND(<col>)::integer for all three
--
--   affiliate_referrals.commission_amount — fils (Math.round(order.total * rate / 100))
--                                          USING: ROUND(commission_amount)::integer
--
--   affiliate_payouts.amount             — fils (admin converts KWD input × 1000 before POST)
--                                          USING: ROUND(amount)::integer
--
--   affiliate_configs.min_payout_amount  — fils (admin stores via Math.round(kwd * 1000))
--                                          USING: ROUND(min_payout_amount)::integer
--
-- NULL handling: ROUND(NULL * 1000) = NULL — nullable columns stay NULL.
-- No data is destroyed; ROUND() on an already-integer decimal is a no-op.
--
-- ⚠️  BACK UP abandoned_carts, abandoned_cart_configs, affiliates,
--     affiliate_referrals, affiliate_payouts, affiliate_configs
--     BEFORE running this migration in production.

-- abandoned_carts.cart_total (fils → integer)
ALTER TABLE "abandoned_carts"
  ALTER COLUMN "cart_total" TYPE integer
  USING ROUND("cart_total")::integer;

-- abandoned_cart_configs.coupon_max_discount (KWD → fils integer)
ALTER TABLE "abandoned_cart_configs"
  ALTER COLUMN "coupon_max_discount" TYPE integer
  USING ROUND("coupon_max_discount" * 1000)::integer;

-- affiliates money columns (fils → integer)
ALTER TABLE "affiliates"
  ALTER COLUMN "total_earned" TYPE integer
  USING ROUND("total_earned")::integer;

ALTER TABLE "affiliates"
  ALTER COLUMN "total_paid" TYPE integer
  USING ROUND("total_paid")::integer;

ALTER TABLE "affiliates"
  ALTER COLUMN "pending_balance" TYPE integer
  USING ROUND("pending_balance")::integer;

-- Update column defaults to integer expressions
ALTER TABLE "affiliates" ALTER COLUMN "total_earned" SET DEFAULT 0;
ALTER TABLE "affiliates" ALTER COLUMN "total_paid" SET DEFAULT 0;
ALTER TABLE "affiliates" ALTER COLUMN "pending_balance" SET DEFAULT 0;

-- affiliate_referrals.commission_amount (fils → integer)
ALTER TABLE "affiliate_referrals"
  ALTER COLUMN "commission_amount" TYPE integer
  USING ROUND("commission_amount")::integer;

-- affiliate_payouts.amount (fils → integer)
ALTER TABLE "affiliate_payouts"
  ALTER COLUMN "amount" TYPE integer
  USING ROUND("amount")::integer;

-- affiliate_configs.min_payout_amount (fils → integer, default stays 5000 fils = 5 KWD)
ALTER TABLE "affiliate_configs"
  ALTER COLUMN "min_payout_amount" TYPE integer
  USING ROUND("min_payout_amount")::integer;

ALTER TABLE "affiliate_configs" ALTER COLUMN "min_payout_amount" SET DEFAULT 5000;
