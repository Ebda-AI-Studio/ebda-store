-- B2B fix wave (final review minor 4): whether a tier / group priced line got its price from the buyer's wholesale GROUP
-- (a group tier or the group percent) rather than a public quantity break. Snapshotted at sale time from the resolver's
-- `groupApplied`, so an invoice labels a public break "Quantity price" and a group tier "Wholesale price", and the
-- price-source analytics buckets a group tier as `group`. NULL on lines placed before this column (labelled as before by
-- price_source alone). Additive, nullable, no default: no table rewrite.
ALTER TABLE "order_items" ADD COLUMN IF NOT EXISTS "price_group_applied" BOOLEAN;
