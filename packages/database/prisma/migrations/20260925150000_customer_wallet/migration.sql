-- D1 — Customer Wallet (store credit). Design + invariants:
-- docs/plans/2026-09-25-customer-wallet.md. Rollback: ./rollback.sql.
--
-- Additive, plus ONE data fix (the last statement below). Every existing order
-- gets wallet_amount = 0 (a constant default — no table rewrite on PG11+),
-- which is exactly the value every payment path already assumes, so nothing
-- live changes until a store has the `customer_wallet` feature switched on.

-- CreateEnum
CREATE TYPE "WalletTransactionType" AS ENUM ('credit', 'debit', 'refund_credit', 'order_payment', 'order_payment_reversal', 'admin_adjust', 'expire');

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "wallet_amount" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "customer_wallets" (
    "id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "balance" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customer_wallets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wallet_transactions" (
    "id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "wallet_id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "balance_after" INTEGER NOT NULL,
    "type" "WalletTransactionType" NOT NULL,
    "order_id" TEXT,
    "return_id" TEXT,
    "idempotency_key" TEXT NOT NULL,
    "actor_id" TEXT,
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wallet_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "customer_wallets_store_id_balance_idx" ON "customer_wallets"("store_id", "balance");

-- CreateIndex
CREATE INDEX "customer_wallets_customer_id_idx" ON "customer_wallets"("customer_id");

-- CreateIndex
CREATE UNIQUE INDEX "customer_wallets_store_id_customer_id_key" ON "customer_wallets"("store_id", "customer_id");

-- CreateIndex
CREATE INDEX "wallet_transactions_store_id_customer_id_created_at_idx" ON "wallet_transactions"("store_id", "customer_id", "created_at");

-- CreateIndex
CREATE INDEX "wallet_transactions_wallet_id_idx" ON "wallet_transactions"("wallet_id");

-- CreateIndex
CREATE INDEX "wallet_transactions_customer_id_idx" ON "wallet_transactions"("customer_id");

-- CreateIndex
CREATE INDEX "wallet_transactions_order_id_idx" ON "wallet_transactions"("order_id");

-- CreateIndex
CREATE INDEX "wallet_transactions_return_id_idx" ON "wallet_transactions"("return_id");

-- CreateIndex
CREATE UNIQUE INDEX "wallet_transactions_store_id_idempotency_key_key" ON "wallet_transactions"("store_id", "idempotency_key");

-- AddForeignKey
ALTER TABLE "customer_wallets" ADD CONSTRAINT "customer_wallets_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_wallets" ADD CONSTRAINT "customer_wallets_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_transactions" ADD CONSTRAINT "wallet_transactions_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_transactions" ADD CONSTRAINT "wallet_transactions_wallet_id_fkey" FOREIGN KEY ("wallet_id") REFERENCES "customer_wallets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_transactions" ADD CONSTRAINT "wallet_transactions_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_transactions" ADD CONSTRAINT "wallet_transactions_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_transactions" ADD CONSTRAINT "wallet_transactions_return_id_fkey" FOREIGN KEY ("return_id") REFERENCES "returns"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Money guards backstopping WalletService.applyEntry. The service refuses a
-- negative balance under a row lock; these make the DATABASE refuse it too,
-- so a future write path that bypasses the service cannot mint debt.
ALTER TABLE "customer_wallets"
  ADD CONSTRAINT "customer_wallets_balance_non_negative" CHECK ("balance" >= 0);
ALTER TABLE "wallet_transactions"
  ADD CONSTRAINT "wallet_transactions_amount_non_zero" CHECK ("amount" <> 0);
ALTER TABLE "wallet_transactions"
  ADD CONSTRAINT "wallet_transactions_balance_after_non_negative" CHECK ("balance_after" >= 0);

-- orders is the largest table in the schema. Prisma sends this file as one
-- multi-statement script, so the ADD COLUMN above already holds orders'
-- ACCESS EXCLUSIVE lock until the script commits and NOT VALID + VALIDATE does
-- not shorten it here; it is written this way so the statement pair stays
-- safe if it is ever split into its own migration. The validation scan is a
-- sequential read of a table whose every row is 0 from the default above.
ALTER TABLE "orders"
  ADD CONSTRAINT "orders_wallet_amount_non_negative" CHECK ("wallet_amount" >= 0) NOT VALID;
ALTER TABLE "orders" VALIDATE CONSTRAINT "orders_wallet_amount_non_negative";

-- Row-level security, copied verbatim from 20260911190000_merchant_api_keys
-- (the latest store-scoped policy set). Inert while production connects as a
-- BYPASSRLS role; it is here so the force_app cutover never finds these
-- tables policy-less.
ALTER TABLE "customer_wallets" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "customer_wallets" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "customer_wallets_app_select" ON "customer_wallets";
CREATE POLICY "customer_wallets_app_select" ON "customer_wallets" FOR SELECT
  USING (current_store_id() IS NULL OR current_setting('app.bypass_rls', true) = 'true' OR store_id = current_store_id());

DROP POLICY IF EXISTS "customer_wallets_app_insert" ON "customer_wallets";
CREATE POLICY "customer_wallets_app_insert" ON "customer_wallets" FOR INSERT
  WITH CHECK (current_store_id() IS NULL OR current_setting('app.bypass_rls', true) = 'true' OR store_id = current_store_id());

DROP POLICY IF EXISTS "customer_wallets_app_update" ON "customer_wallets";
CREATE POLICY "customer_wallets_app_update" ON "customer_wallets" FOR UPDATE
  USING (current_store_id() IS NULL OR current_setting('app.bypass_rls', true) = 'true' OR store_id = current_store_id())
  WITH CHECK (current_store_id() IS NULL OR current_setting('app.bypass_rls', true) = 'true' OR store_id = current_store_id());

DROP POLICY IF EXISTS "customer_wallets_app_delete" ON "customer_wallets";
CREATE POLICY "customer_wallets_app_delete" ON "customer_wallets" FOR DELETE
  USING (current_store_id() IS NULL OR current_setting('app.bypass_rls', true) = 'true' OR store_id = current_store_id());

ALTER TABLE "wallet_transactions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "wallet_transactions" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "wallet_transactions_app_select" ON "wallet_transactions";
CREATE POLICY "wallet_transactions_app_select" ON "wallet_transactions" FOR SELECT
  USING (current_store_id() IS NULL OR current_setting('app.bypass_rls', true) = 'true' OR store_id = current_store_id());

DROP POLICY IF EXISTS "wallet_transactions_app_insert" ON "wallet_transactions";
CREATE POLICY "wallet_transactions_app_insert" ON "wallet_transactions" FOR INSERT
  WITH CHECK (current_store_id() IS NULL OR current_setting('app.bypass_rls', true) = 'true' OR store_id = current_store_id());

DROP POLICY IF EXISTS "wallet_transactions_app_update" ON "wallet_transactions";
CREATE POLICY "wallet_transactions_app_update" ON "wallet_transactions" FOR UPDATE
  USING (current_store_id() IS NULL OR current_setting('app.bypass_rls', true) = 'true' OR store_id = current_store_id())
  WITH CHECK (current_store_id() IS NULL OR current_setting('app.bypass_rls', true) = 'true' OR store_id = current_store_id());

DROP POLICY IF EXISTS "wallet_transactions_app_delete" ON "wallet_transactions";
CREATE POLICY "wallet_transactions_app_delete" ON "wallet_transactions" FOR DELETE
  USING (current_store_id() IS NULL OR current_setting('app.bypass_rls', true) = 'true' OR store_id = current_store_id());

-- DEFAULT OFF — reset stale `customer_wallet` overrides (Ruling W-1).
--
-- Feature resolution is PLAN_BASELINE then StoreFeature overrides. The key is
-- in no plan baseline, but until this release it was a HIDDEN placeholder with
-- no backing code, and an "enable everything" sweep left an enabled=true
-- override on a live store (production, read-only query 2026-09-25: exactly
-- one row, store `palora`, enabled_at 2026-03-23, set alongside 20 other keys
-- incl. the still-hidden `email_campaigns`). That row expresses no merchant
-- intent — the toggle did nothing when it was set — but the moment this
-- release wires behaviour to the key it would switch the wallet ON for that
-- store at deploy. Turning the wallet on must be a deliberate super-admin
-- action taken after this release, so every override that exists when this
-- runs is forced OFF (kept as an explicit off row rather than deleted, which
-- also holds it off if the key ever joins a plan baseline). `enabled_at` is
-- cleared the same way FeatureService.updateStoreFeatures does on disable.
-- The API's feature cache namespace is bumped in the same release
-- (feature.service.ts), so no cached `true` outlives this update.
UPDATE "store_features"
SET "enabled" = false, "enabled_at" = NULL, "updated_at" = CURRENT_TIMESTAMP
WHERE "feature_key" = 'customer_wallet';
