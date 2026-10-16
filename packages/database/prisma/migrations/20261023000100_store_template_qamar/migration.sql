-- Qamar storefront skin (Phase B1, Ruling B1-1): one more value on the store
-- template enum. Additive only: no existing row changes; a store reaches it only
-- through a Qamar look (applyLook writes template = look.skin). Rollback: see
-- docs/ROLLBACK.md ("Qamar template enum value"). Postgres cannot remove an enum
-- value, so a rollback moves any 'qamar' stores to 'minimal' and leaves the value
-- unused.
ALTER TYPE "StoreTemplate" ADD VALUE IF NOT EXISTS 'qamar';
