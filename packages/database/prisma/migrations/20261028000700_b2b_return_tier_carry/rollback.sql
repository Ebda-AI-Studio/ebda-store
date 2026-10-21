-- rollback.sql for 20261028000700_b2b_return_tier_carry.
-- Roll the CODE back first (ReturnService reads this column). Loses only the outstanding carries: completed returns keep
-- their refunded amounts and persisted adjustments; a later return of a product with a carry is computed as before B2B-20.
ALTER TABLE "return_items" DROP COLUMN IF EXISTS "tier_carry";

-- After running this, delete the migration's row too:
--   DELETE FROM _prisma_migrations WHERE migration_name = '20261028000700_b2b_return_tier_carry';
