-- Hand-written (Ruling GUEST-RET-1), the StoreDO twin of Postgres 20261111100000_guest_return_customer_nullable.
-- returns.customer_id was NOT NULL, so a guest order (no customer) could not have a return. SQLite cannot drop NOT NULL
-- in place and a table rebuild would fire the ON DELETE actions of return_items and wallet_transactions, so the column is
-- replaced instead: rename it aside, add the nullable one, copy ('' becomes NULL), drop the old one. No parent row is
-- dropped, no foreign key is touched. The index on the column is dropped first and rebuilt after. A DO that was created
-- with the regenerated 0001 already has the nullable column and runs the same steps to the same result.
DROP INDEX IF EXISTS "returns_customer_id_idx";
ALTER TABLE "returns" RENAME COLUMN "customer_id" TO "customer_id_old";
ALTER TABLE "returns" ADD COLUMN "customer_id" TEXT;
UPDATE "returns" SET "customer_id" = NULLIF("customer_id_old", '');
ALTER TABLE "returns" DROP COLUMN "customer_id_old";
CREATE INDEX IF NOT EXISTS "returns_customer_id_idx" ON "returns" ("customer_id");
