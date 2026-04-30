-- Drop NOT NULL on orders.customer_id so guest checkouts (no auth) can
-- create orders. The Prisma schema has had `customerId String?` for a
-- while, but the original `20241227000000_initial_schema` migration
-- declared the column as `TEXT NOT NULL` — drift between schema and
-- DB went unnoticed until the storefront started supporting guest
-- checkout, at which point every guest order failed with
-- `P2011 — Null constraint violation on the constraint: customer_id`.
--
-- Also re-target the foreign key with ON DELETE SET NULL so a
-- soft-deleted customer doesn't cascade-delete their order history.
-- The current schema declares `onDelete: SetNull`; the prod constraint
-- still says ON DELETE RESTRICT from the original migration. Both
-- changes belong in one migration so the FK rebuild is atomic.

ALTER TABLE "orders" ALTER COLUMN "customer_id" DROP NOT NULL;

ALTER TABLE "orders" DROP CONSTRAINT IF EXISTS "orders_customer_id_fkey";
ALTER TABLE "orders"
  ADD CONSTRAINT "orders_customer_id_fkey"
  FOREIGN KEY ("customer_id")
  REFERENCES "users"("id")
  ON DELETE SET NULL
  ON UPDATE CASCADE;
