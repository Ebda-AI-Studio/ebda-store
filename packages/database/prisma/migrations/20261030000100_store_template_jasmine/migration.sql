-- Jasmine storefront skin (Phase B3, Ruling B3-1): one more value on the store template
-- enum. Additive only: no existing row changes; a store reaches it only through a
-- Jasmine look (applyLook writes template = look.skin). Rollback: see docs/ROLLBACK.md
-- ("Jasmine template enum value"). Postgres cannot remove an enum value, so a rollback
-- moves any 'jasmine' stores to 'minimal' and leaves the value unused.
ALTER TYPE "StoreTemplate" ADD VALUE IF NOT EXISTS 'jasmine';
