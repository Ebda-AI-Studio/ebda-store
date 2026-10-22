-- Souq storefront skin (Phase B2, Ruling B2-1): one more value on the store template
-- enum. Additive only: no existing row changes; a store reaches it only through a
-- Souq look (applyLook writes template = look.skin). Rollback: see docs/ROLLBACK.md
-- ("Souq template enum value"). Postgres cannot remove an enum value, so a rollback
-- moves any 'souq' stores to 'minimal' and leaves the value unused.
ALTER TYPE "StoreTemplate" ADD VALUE IF NOT EXISTS 'souq';
