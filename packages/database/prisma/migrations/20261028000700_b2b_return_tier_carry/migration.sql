-- B2B Ruling B2B-20: when an early partial return hits the zero-refund floor, the part of the tier adjustment it could not
-- collect is carried forward and collected first by the product's later returns (never below a 0 refund, consumed once).
-- return_items.tier_carry: the signed change this return made to the product's carried amount (+ carried, - consumed or
-- waived by a merchant override). Additive, NOT NULL with a constant default: no table rewrite on PG 11+.
ALTER TABLE "return_items" ADD COLUMN IF NOT EXISTS "tier_carry" INTEGER NOT NULL DEFAULT 0;
