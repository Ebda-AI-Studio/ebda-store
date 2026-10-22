-- Lamma storefront skin (Phase B4, Ruling B4-1): one more value on the store template
-- enum. Additive only: no existing row changes; a store reaches it only through a
-- Lamma look (applyLook writes template = look.skin). Rollback: see docs/ROLLBACK.md
-- ("Lamma template enum value"). Postgres cannot remove an enum value, so a rollback
-- moves any 'lamma' stores to 'minimal' and leaves the value unused.
ALTER TYPE "StoreTemplate" ADD VALUE IF NOT EXISTS 'lamma';
