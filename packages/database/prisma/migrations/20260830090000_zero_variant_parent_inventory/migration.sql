-- Repair: `products.inventory` is on-hand stock ONLY for a product with no
-- variants. For a variant product the stock lives on `product_variants` and
-- the parent column is unused.
--
-- Until 2026-08-30 checkout mirrored every variant sale onto the parent with
-- an unfloored decrement, and PO-receive mirrored every variant receipt onto
-- it. Because a variant product's parent column starts at 0, it drifted:
-- of 191 variant products, 63 hold a non-zero parent (the rows this
-- statement resets) and 24 of those had gone negative — as far as -16
-- against variants holding 1173. Eleven read paths then turned that drift
-- into a permanent "out of stock" that no variant edit could clear.
--
-- Verified by dry-run inside a rolled-back transaction on 2026-08-30:
-- 63 rows updated, 0 variant products left non-zero, and all 285 non-variant
-- rows (whose `inventory` IS their real stock) untouched.
--
-- The writers are fixed in this same release (see
-- docs/superpowers/plans/2026-08-30-variant-stock-drift.md), so this reset is
-- one-shot, not recurring. Zero — not the variant sum — is deliberate: a
-- snapshot of the sum would be a number nothing maintains, and the next
-- variant-blind reader would silently consume a stale value instead of
-- failing visibly.
UPDATE public.products p
SET inventory = 0
WHERE p.inventory <> 0
  AND EXISTS (SELECT 1 FROM public.product_variants v WHERE v.product_id = p.id);
