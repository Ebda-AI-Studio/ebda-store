-- Tenant-scoped customer auth.
--
-- Goal: customer accounts are scoped to a single store. The same email
-- address can register on Store A and Store B without colliding. Admin
-- accounts (store_admin / super_admin) remain platform-wide and store
-- NULL in `users.store_id` — Postgres treats NULLs as distinct in unique
-- constraints, so the partial index below is what enforces global
-- uniqueness for admin emails.
--
-- Backfill rule for existing rows with role='customer':
--   1. If the user has orders in exactly one store, assign that store_id.
--   2. If they have orders in multiple stores, take the most-frequent.
--   3. If they have no orders, leave store_id NULL — these are demo /
--      orphaned accounts that pre-date multi-tenancy and the merchant can
--      delete them via the audit log.

-- Step 1: Add the new column. Nullable so the backfill can land before we
-- enforce any uniqueness.
ALTER TABLE "users" ADD COLUMN "store_id" TEXT;

-- Step 2: Backfill store_id for customer rows from their order history.
-- Picks the most-frequent store the customer has ordered from. Customers
-- with no orders stay NULL.
UPDATE "users" u
SET "store_id" = (
  SELECT "store_id"
  FROM "orders"
  WHERE "customer_id" = u."id"
  GROUP BY "store_id"
  ORDER BY COUNT(*) DESC, MAX("created_at") DESC
  LIMIT 1
)
WHERE u."role" = 'customer';

-- Step 3: Drop the old global email unique constraint. Prisma named it
-- `users_email_key`. The DROP IF EXISTS guards against dev databases
-- where the constraint may already be missing or named differently.
ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "users_email_key";

-- Step 4: Composite unique on (store_id, email). Customers in different
-- stores can share an email; rows with NULL store_id (admins) are not
-- constrained by this index because Postgres treats NULLs as distinct in
-- multi-column unique indexes.
CREATE UNIQUE INDEX "users_store_id_email_key" ON "users"("store_id", "email");

-- Step 5: Partial unique on email WHERE store_id IS NULL. Keeps admin
-- emails globally unique while letting customer rows scope by store.
CREATE UNIQUE INDEX "users_admin_email_key" ON "users"("email") WHERE "store_id" IS NULL;

-- Step 6: FK to stores. ON DELETE CASCADE so deleting a tenant cleans up
-- their customer accounts; admins (store_id NULL) are unaffected.
ALTER TABLE "users"
  ADD CONSTRAINT "users_store_id_fkey"
  FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Step 7: Index for the FK lookup.
CREATE INDEX "users_store_id_idx" ON "users"("store_id");
