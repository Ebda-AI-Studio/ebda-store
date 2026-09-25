-- Rollback for 20260925150000_customer_wallet (hand-written; Prisma does not
-- generate down migrations).
--
-- DESTRUCTIVE: drops every wallet balance and ledger row. Before running it
-- against production, export the ledger if any store has used the feature:
--   \copy (SELECT * FROM wallet_transactions ORDER BY created_at) TO 'wallet_transactions.csv' CSV HEADER
--   \copy (SELECT * FROM customer_wallets) TO 'customer_wallets.csv' CSV HEADER
-- and confirm no unsettled order still carries a wallet portion:
--   SELECT id, order_number, total, wallet_amount, status FROM orders WHERE wallet_amount > 0;
-- Dropping orders.wallet_amount while such an order is still awaiting a
-- gateway payment would make the gateway charge the FULL total again.
--
-- Then remove the migration row so a re-deploy re-applies it cleanly:
--   DELETE FROM _prisma_migrations WHERE migration_name = '20260925150000_customer_wallet';
--
-- Policies are dropped with their tables.
--
-- NOT reversed: the migration's reset of stale `customer_wallet` overrides to
-- enabled = false (Ruling W-1). The previous `true` (store `palora`) was a
-- leftover from when the key was a hidden no-op, and nothing here restores
-- it. Re-enabling the wallet for any store is a deliberate, manual
-- super-admin toggle on /stores/<id>/features — never a side effect of a
-- rollback.

BEGIN;

DROP TABLE IF EXISTS "wallet_transactions";
DROP TABLE IF EXISTS "customer_wallets";
DROP TYPE IF EXISTS "WalletTransactionType";

ALTER TABLE "orders" DROP CONSTRAINT IF EXISTS "orders_wallet_amount_non_negative";
ALTER TABLE "orders" DROP COLUMN IF EXISTS "wallet_amount";

COMMIT;
