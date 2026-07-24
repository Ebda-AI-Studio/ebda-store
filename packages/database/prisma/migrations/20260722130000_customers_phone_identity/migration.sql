-- Migration: customers_phone_identity
--
-- Make the `customers` table usable as a phone-first shopper identity so the
-- customer-groups feature is reachable for real customers (not just seed data).
--
-- Context: `customers` is written today only by seed scripts; real shoppers
-- become `users` (via `orders.customer_id`) or anonymous guests. The store-level
-- admin customer views are built from order aggregation, keyed by phone/email.
-- In the GCC most shoppers give a phone and no email. The group-assignment
-- bridge (PUT /stores/:storeId/customers/group-assignment) upserts a `customers`
-- row on assignment, matching by phone first, so a real customer can be put in a
-- group from the customer-detail page.
--
-- Changes:
--   • email DROP NOT NULL — a phone-only customer has no email. The existing
--     UNIQUE (store_id, email) stays valid: Postgres treats NULLs as distinct,
--     so many phone-only rows coexist. Empty string would collide, so the app
--     writes NULL (never '') when email is unknown.
--   • UNIQUE (store_id, phone) — phone is the upsert key, so it must be unique
--     per store to stop concurrent assigns creating duplicate customer rows
--     (same guard rationale as customer_groups' partial default index). NULL
--     phones are distinct, so phone-less rows (email-only) are unconstrained.
--
-- RLS: unchanged. `customers` already has FORCE ROW LEVEL SECURITY with the
-- canonical per-command hybrid policies (from 20260609000000). Adding a column
-- constraint / index needs no new policy — the SELECT/INSERT/UPDATE policies
-- already cover the bridge's upsert.

ALTER TABLE "customers" ALTER COLUMN "email" DROP NOT NULL;

CREATE UNIQUE INDEX "customers_store_id_phone_key"
  ON "customers" ("store_id", "phone");
