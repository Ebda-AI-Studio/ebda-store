-- SP6b: the Kuwait gateways are gone from Ebda (FWB upstream keeps them).
--
--   payment_configs.provider   'tap' | 'myfatoorah' | 'hesabe' | 'upayments' removed
--
-- Postgres cannot drop an enum value, so the type is rebuilt. Ebda never had a
-- Kuwait merchant, so any row still carrying one of the removed values (a forked
-- dev database) is deleted first: it could not be charged against anything.
-- `payment_configs` is FORCE row-level-secured, which binds even the owner, so the
-- delete runs with FORCE lifted for this transaction only (restored right after).

ALTER TABLE "payment_configs" NO FORCE ROW LEVEL SECURITY;
DELETE FROM "payment_configs" WHERE "provider"::text IN ('tap', 'myfatoorah', 'hesabe', 'upayments');
ALTER TABLE "payment_configs" FORCE ROW LEVEL SECURITY;

ALTER TYPE "PaymentProvider" RENAME TO "PaymentProvider_old";
CREATE TYPE "PaymentProvider" AS ENUM ('cod', 'instapay', 'paymob', 'kashier', 'fawry');
ALTER TABLE "payment_configs"
  ALTER COLUMN "provider" TYPE "PaymentProvider" USING ("provider"::text::"PaymentProvider");
DROP TYPE "PaymentProvider_old";

-- `payments.provider` defaulted to 'tap': a payment row must now name its provider.
ALTER TABLE "payments" ALTER COLUMN "provider" DROP DEFAULT;
