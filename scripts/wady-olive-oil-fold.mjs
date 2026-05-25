// Consolidate the 5 standalone "زيت زيتون فلسطيني" SKUs into a single
// parent product (WJ-54) with size variants 2-liter / 4-liter /
// 16-liter. Existing user-created variants on WJ-54 are dropped first
// so the new variants are the only ones — the merchant asked to redo
// what they'd manually configured.
//
// Inputs are hard-coded from /tmp/wady-olive-oil-survey output:
//   WJ-54  parent (kept, hasVariants=true, name cleaned)
//   WJ-55  fold to 4-liter variant
//   WJ-56  fold to 16-liter variant
//   WJ-256 fold to 16-liter variant   ← duplicate of WJ-56
//   WJ-257 fold to 2-liter variant
//
// Price decisions:
//   2L  → 9 KWD  (WJ-257)
//   4L  → 16 KWD (WJ-55)
//   16L → 57 KWD (WJ-256, newer of the two 16L SKUs)
// Inventory: sum of all duplicates feeding that size.
//
// Dry-run by default. Pass `--apply` to write.
import { prisma } from '@force/database';

const STORE_ID = 'dfc1c208-1c30-4eba-9821-6f3be15e3506';
const APPLY = process.argv.includes('--apply');

// SKU → role
const PLAN = {
  'WJ-54': { role: 'parent' },
  'WJ-55': { role: 'fold', size: '4 لتر', sizeEn: '4-liter' },
  'WJ-56': { role: 'fold', size: '16 لتر', sizeEn: '16-liter' },
  'WJ-256': { role: 'fold', size: '16 لتر', sizeEn: '16-liter' },
  'WJ-257': { role: 'fold', size: '2 لتر', sizeEn: '2-liter' },
};

// Variant blueprint — one entry per distinct size. The merchant can
// edit prices in the admin if these need to shift.
const VARIANTS = [
  {
    sizeAr: '2 لتر',
    sizeEn: '2-liter',
    price: 9000, // 9 KWD in fils
    sku: 'WJ-OO-2L',
    sourceSku: 'WJ-257',
  },
  {
    sizeAr: '4 لتر',
    sizeEn: '4-liter',
    price: 16000, // 16 KWD
    sku: 'WJ-OO-4L',
    sourceSku: 'WJ-55',
  },
  {
    sizeAr: '16 لتر',
    sizeEn: '16-liter',
    price: 57000, // 57 KWD
    sku: 'WJ-OO-16L',
    sourceSku: 'WJ-256',
  },
];

const products = await prisma.product.findMany({
  where: { storeId: STORE_ID, sku: { in: Object.keys(PLAN) } },
  select: {
    id: true,
    sku: true,
    nameAr: true,
    name: true,
    inventory: true,
    images: { orderBy: { position: 'asc' }, select: { url: true } },
    variants: { select: { id: true, title: true, titleAr: true } },
  },
});

const bySku = new Map(products.map(p => [p.sku, p]));

console.log(`Mode: ${APPLY ? 'APPLY' : 'DRY-RUN'}`);
console.log(`Located ${products.length}/${Object.keys(PLAN).length} products from PLAN.\n`);

const parent = bySku.get('WJ-54');
if (!parent) {
  console.error('Parent WJ-54 not found — abort.');
  await prisma.$disconnect();
  process.exit(1);
}

// Inventory roll-up: sum the duplicates feeding each size.
const inventoryBySize = {};
for (const [sku, def] of Object.entries(PLAN)) {
  if (def.role !== 'fold') continue;
  const p = bySku.get(sku);
  if (!p) continue;
  inventoryBySize[def.size] = (inventoryBySize[def.size] || 0) + (p.inventory ?? 0);
}
// Parent itself contributes to whichever size matches its own — WJ-54
// is currently labelled "2 بتر" / 2 كيلو ≈ 2L, so add its inventory
// to the 2-liter total.
inventoryBySize['2 لتر'] = (inventoryBySize['2 لتر'] || 0) + (parent.inventory ?? 0);

console.log('Inventory roll-up:');
for (const [size, inv] of Object.entries(inventoryBySize)) {
  console.log(`  ${size}: ${inv}`);
}

console.log('\nPlanned variants:');
for (const v of VARIANTS) {
  const inv = inventoryBySize[v.sizeAr] ?? 0;
  console.log(
    `  ${v.sizeAr.padEnd(8)}  ${(v.price / 1000).toFixed(3).padStart(7)} KWD  inv=${inv}`
  );
}
console.log('\nFolds:');
for (const [sku, def] of Object.entries(PLAN)) {
  if (def.role === 'fold') {
    const p = bySku.get(sku);
    console.log(`  ${sku} → ${def.size}  (${p?.nameAr || '?'})`);
  }
}

if (!APPLY) {
  await prisma.$disconnect();
  console.log('\nDRY RUN — pass --apply to write.');
  process.exit(0);
}

await prisma.$transaction(
  async tx => {
    // 1. Drop ALL existing variants on the parent (user-created).
    // ProductVariantOption rows cascade away because of the FK.
    const dropped = await tx.productVariant.deleteMany({
      where: { productId: parent.id },
    });
    console.log(`  dropped ${dropped.count} existing variant(s) on ${parent.sku}`);

    // 1b. Drop any old ProductOption rows on the parent — we'll
    // recreate the size option from scratch.
    const oldOpts = await tx.productOption.findMany({
      where: { productId: parent.id },
      select: { id: true },
    });
    if (oldOpts.length > 0) {
      await tx.productOption.deleteMany({
        where: { id: { in: oldOpts.map(o => o.id) } },
      });
      console.log(`  dropped ${oldOpts.length} old option(s) on ${parent.sku}`);
    }

    // 2. Mark parent hasVariants + clean its display name.
    await tx.product.update({
      where: { id: parent.id },
      data: {
        hasVariants: true,
        name: 'Palestinian Olive Oil',
        nameAr: 'زيت زيتون فلسطيني',
        // Description is per-variant in the storefront UI; keep the
        // generic text here.
        description: 'Origin: Palestine',
        descriptionAr: 'المنشأ: فلسطين',
      },
    });

    // 3. Create the size option + values.
    const option = await tx.productOption.create({
      data: {
        productId: parent.id,
        name: 'Size',
        nameAr: 'الحجم',
        position: 0,
      },
    });
    const valueIdBySize = new Map();
    for (const [i, v] of VARIANTS.entries()) {
      const val = await tx.productOptionValue.create({
        data: {
          optionId: option.id,
          value: v.sizeEn,
          valueAr: v.sizeAr,
          position: i,
        },
      });
      valueIdBySize.set(v.sizeAr, val.id);
    }

    // 4. Create one variant per size with rolled-up inventory.
    const variantIdBySize = new Map();
    for (const v of VARIANTS) {
      const sourceProduct = bySku.get(v.sourceSku);
      const created = await tx.productVariant.create({
        data: {
          productId: parent.id,
          title: `${v.sizeEn} Palestinian Olive Oil`,
          titleAr: `زيت زيتون فلسطيني ${v.sizeAr}`,
          sku: v.sku,
          price: v.price,
          inventory: inventoryBySize[v.sizeAr] ?? 0,
          imageUrl: sourceProduct?.images[0]?.url ?? parent.images[0]?.url ?? null,
          isActive: true,
          position: VARIANTS.indexOf(v),
        },
      });
      await tx.productVariantOption.create({
        data: { variantId: created.id, valueId: valueIdBySize.get(v.sizeAr) },
      });
      variantIdBySize.set(v.sizeAr, created.id);
    }

    // 5. Rewrite OrderItem / WishlistItem / CartItem refs from each
    //    fold-source onto the parent + matched variant.
    for (const [sku, def] of Object.entries(PLAN)) {
      if (def.role !== 'fold') continue;
      const p = bySku.get(sku);
      if (!p) continue;
      const variantId = variantIdBySize.get(def.size);
      const variantTitle = `زيت زيتون فلسطيني ${def.size}`;

      await tx.orderItem.updateMany({
        where: { productId: p.id, variantId: null },
        data: { productId: parent.id, variantId, variantName: variantTitle },
      });
      await tx.cartItem.updateMany({
        where: { productId: p.id, variantId: null },
        data: { productId: parent.id, variantId },
      });
      await tx.wishlistItem.updateMany({
        where: { productId: p.id },
        data: { productId: parent.id },
      });

      // Soft-delete the duplicate product
      await tx.product.update({
        where: { id: p.id },
        data: { deletedAt: new Date() },
      });
    }

    // 6. Parent's own historical OrderItems get stamped to the 2-liter
    //    variant (the parent was originally a 2L product).
    const parent2L = variantIdBySize.get('2 لتر');
    if (parent2L) {
      await tx.orderItem.updateMany({
        where: { productId: parent.id, variantId: null },
        data: { variantId: parent2L, variantName: `زيت زيتون فلسطيني 2 لتر` },
      });
    }
  },
  { timeout: 30_000 }
);

// 7. Strip orphan ProductCategory rows on the soft-deleted siblings
await prisma.productCategory.deleteMany({
  where: {
    category: { storeId: STORE_ID },
    product: { deletedAt: { not: null } },
  },
});

console.log('\n✓ Olive oil consolidation complete.');

await prisma.$disconnect();
