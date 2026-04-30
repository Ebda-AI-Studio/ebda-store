// Backfill: for every Product that has variants, sync the parent's
// own `price` and `compareAtPrice` to match the cheapest variant.
//
// Why:
//   - Admin product list (and any sort/filter that reads parent.price)
//     was showing stale pre-fold prices on variant parents — the
//     parent kept the price of whichever sibling we picked as the
//     "primary" before the variant feature shipped.
//   - Storefront cards now read from variants directly via
//     getProductPricing, but legacy code paths and the admin still
//     reach for parent.price. Aligning the parent makes both work.
//   - parent.compareAtPrice was producing fake "20% OFF" badges —
//     the parent retained a discount marker but no variant inherited
//     it. Clear the parent's compareAtPrice when no variant on the
//     product carries one of its own.
//
// Dry-run by default. Pass `--apply` to write.
import { prisma } from '@force/database';

const APPLY = process.argv.includes('--apply');

const parents = await prisma.product.findMany({
  where: { hasVariants: true, deletedAt: null },
  select: {
    id: true,
    sku: true,
    nameAr: true,
    name: true,
    price: true,
    compareAtPrice: true,
    storeId: true,
    variants: {
      where: { isActive: true },
      select: { id: true, price: true, compareAtPrice: true },
    },
  },
});

console.log(`Mode: ${APPLY ? 'APPLY' : 'DRY-RUN'}`);
console.log(`Variant parents: ${parents.length}\n`);

let priceUpdates = 0;
let compareClears = 0;
let skipped = 0;

for (const p of parents) {
  if (p.variants.length === 0) {
    skipped += 1;
    console.log(`  ${p.sku?.padEnd(8) || '-'} (${(p.nameAr || p.name || '').slice(0, 30)}) — no active variants, skipping`);
    continue;
  }
  const variantPrices = p.variants
    .map(v => v.price)
    .filter((x) => typeof x === 'number');
  if (variantPrices.length === 0) {
    skipped += 1;
    continue;
  }
  const minPrice = Math.min(...variantPrices);
  const anyVariantHasCompare = p.variants.some(
    v => typeof v.compareAtPrice === 'number' && typeof v.price === 'number' && v.compareAtPrice > v.price
  );

  const data = {};
  let willChange = false;

  if (p.price !== minPrice) {
    data.price = minPrice;
    willChange = true;
    priceUpdates += 1;
  }
  // Clear parent.compareAtPrice if it's a leftover (no variant carries
  // a discount of its own). Keep it only when the parent.compareAt is
  // pointing at a real per-product discount the merchant set BEFORE
  // they configured variants, AND no variant overrides it.
  if (p.compareAtPrice && !anyVariantHasCompare) {
    data.compareAtPrice = null;
    willChange = true;
    compareClears += 1;
  }

  if (!willChange) continue;

  const before = `price=${(p.price / 1000).toFixed(3)} compareAt=${p.compareAtPrice ? (p.compareAtPrice / 1000).toFixed(3) : '-'}`;
  const after = `price=${(minPrice / 1000).toFixed(3)} compareAt=${'compareAtPrice' in data ? '-' : p.compareAtPrice ? (p.compareAtPrice / 1000).toFixed(3) : '-'}`;
  console.log(`  ${p.sku?.padEnd(8) || '-'} (${(p.nameAr || p.name || '').slice(0, 30).padEnd(30)})  ${before}  →  ${after}`);

  if (APPLY) {
    await prisma.product.update({ where: { id: p.id }, data });
  }
}

console.log(`\nWould-update: price=${priceUpdates}, clear-compareAt=${compareClears}, skipped (no variants)=${skipped}`);
await prisma.$disconnect();
if (!APPLY) console.log('\nDRY RUN — pass --apply to write.');
