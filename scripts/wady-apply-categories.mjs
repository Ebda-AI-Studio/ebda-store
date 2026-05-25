// Apply the new 8-bucket category scheme to Wady Aljuz.
//
// Reads:  /tmp/wady-classification.json
// Effect:
//   1. Create the 8 new categories (idempotent; reuse if slug already
//      exists from a previous run).
//   2. For every product, drop ALL old ProductCategory links and write
//      a single link to the new bucket. (Multi-bucket assignment is
//      possible later by editing in the admin.)
//   3. Soft-delete every old category that ends up with 0 products.
//   4. Also bust the public-cache key so the storefront sees the
//      change immediately.
//
// Dry-run by default; pass `--apply` to actually write.
import { prisma } from '@force/database';
import { readFileSync } from 'fs';

const STORE_ID = 'dfc1c208-1c30-4eba-9821-6f3be15e3506';
const APPLY = process.argv.includes('--apply');

const { buckets, proposal } = JSON.parse(readFileSync('/tmp/wady-classification.json', 'utf8'));

console.log(`Mode: ${APPLY ? 'APPLY' : 'DRY-RUN'}`);
console.log(`Store: ${STORE_ID}`);
console.log(
  `Proposal covers ${proposal.length} products into ${Object.keys(buckets).length} buckets.`
);

// ---------------------------------------------------------------
// Step 1 — upsert the 8 new categories
// ---------------------------------------------------------------
const slugToId = new Map();
for (const [slug, def] of Object.entries(buckets)) {
  const existing = await prisma.category.findFirst({
    where: { storeId: STORE_ID, slug },
    select: { id: true, deletedAt: true },
  });
  if (existing) {
    if (existing.deletedAt) {
      if (APPLY) {
        await prisma.category.update({
          where: { id: existing.id },
          data: { deletedAt: null, isActive: true, position: def.position },
        });
      }
      console.log(`  reactivated existing category: ${slug}`);
    } else {
      console.log(`  reuse existing category: ${slug}`);
    }
    slugToId.set(slug, existing.id);
  } else {
    if (APPLY) {
      const created = await prisma.category.create({
        data: {
          storeId: STORE_ID,
          slug,
          name: def.name,
          nameAr: def.nameAr,
          isActive: true,
          position: def.position,
        },
        select: { id: true },
      });
      slugToId.set(slug, created.id);
    } else {
      slugToId.set(slug, `<would-create-${slug}>`);
    }
    console.log(`  ${APPLY ? 'created' : 'would create'} category: ${slug}  (${def.nameAr})`);
  }
}

// ---------------------------------------------------------------
// Step 2 — rewrite product → category links (bulk, ONE transaction)
// ---------------------------------------------------------------
const productIds = [];
const newLinks = [];
let skipped = 0;
for (const item of proposal) {
  if (!item.newBucket) {
    skipped += 1;
    continue;
  }
  const newCategoryId = slugToId.get(item.newBucket);
  if (!newCategoryId) {
    console.warn(
      `  WARN: bucket ${item.newBucket} not in slugToId — skipping product ${item.productId}`
    );
    skipped += 1;
    continue;
  }
  productIds.push(item.productId);
  newLinks.push({ productId: item.productId, categoryId: newCategoryId });
}
console.log(`Planned: rewrite ${newLinks.length} product→category links (skip ${skipped}).`);

if (APPLY && newLinks.length > 0) {
  // Single transaction: drop every old ProductCategory row for these
  // products, then bulk-insert the new ones. 264 separate transactions
  // would hammer Neon; this is one round-trip per statement.
  await prisma.$transaction([
    prisma.productCategory.deleteMany({ where: { productId: { in: productIds } } }),
    prisma.productCategory.createMany({ data: newLinks, skipDuplicates: true }),
  ]);
  console.log(`Applied ${newLinks.length} rewrites in 1 transaction.`);
}

// ---------------------------------------------------------------
// Step 3 — soft-delete old categories that have no products
// ---------------------------------------------------------------
const oldCats = await prisma.category.findMany({
  where: {
    storeId: STORE_ID,
    deletedAt: null,
    slug: { notIn: Object.keys(buckets) },
  },
  select: {
    id: true,
    name: true,
    nameAr: true,
    slug: true,
    _count: { select: { products: true } },
  },
});
let deleted = 0;
for (const cat of oldCats) {
  if (cat._count.products === 0) {
    if (APPLY) {
      await prisma.category.update({
        where: { id: cat.id },
        data: { deletedAt: new Date(), isActive: false },
      });
    }
    console.log(
      `  ${APPLY ? 'soft-deleted' : 'would soft-delete'} old empty category: ${cat.nameAr || cat.name}`
    );
    deleted += 1;
  } else {
    console.log(`  KEPT (${cat._count.products} products still linked): ${cat.nameAr || cat.name}`);
  }
}

await prisma.$disconnect();
// Storefront caches the public category list for 60-120s; the
// merchant should hard-refresh, or we wait one TTL window for the
// next request. Skipping an explicit Redis bust keeps this script
// dependency-free.
console.log(`\nDone. Old empty cats removed: ${deleted}.`);
if (!APPLY) console.log(`\nDRY RUN — pass --apply to write.`);
