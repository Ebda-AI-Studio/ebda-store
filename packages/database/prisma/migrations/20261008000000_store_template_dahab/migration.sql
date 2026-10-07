-- Dahab storefront template (builder Phase 3 pilot): one more value on the
-- store template enum. Additive only: no existing row changes, nothing reads
-- the new value until a store opts in. Rollback: see docs/ROLLBACK.md
-- ("enum value added") — Postgres cannot DROP an enum value, so a rollback
-- moves any 'dahab' stores back to 'elegant' and leaves the value unused.
ALTER TYPE "StoreTemplate" ADD VALUE IF NOT EXISTS 'dahab';
