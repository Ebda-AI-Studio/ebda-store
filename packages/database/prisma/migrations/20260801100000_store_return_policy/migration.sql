-- Store return policy — powers `hasMerchantReturnPolicy` in the storefront's
-- Product JSON-LD so AI shopping agents can filter on return window.
--
-- Both columns are NULLABLE WITH NO DEFAULT, deliberately:
--   NULL = the merchant has not declared a policy -> storefront omits the block
--   0    = the merchant does not accept returns   -> published as MerchantReturnNotPermitted
-- Backfilling a default would publish a return commitment on behalf of every
-- existing merchant that none of them agreed to.
--
-- Both are plain nullable ADD COLUMNs, so Postgres records them in the catalog
-- without rewriting the table — safe on a live `stores` table.

ALTER TABLE "stores" ADD COLUMN "return_window_days" INTEGER;
ALTER TABLE "stores" ADD COLUMN "return_fees_paid_by" TEXT;
