// Soft-delete the physical "best-sellers" category that was created
// during the 2026-04-30 category overhaul. The Best Sellers section
// now ships as a VIRTUAL category from the API (driven by
// Product.isBestSeller) so the physical row is dead weight.
//
// Hits the categories cache after the soft-delete so the storefront
// sees the new shape on the next request.
import { prisma } from '@force/database';

const STORE_ID = 'dfc1c208-1c30-4eba-9821-6f3be15e3506';
const APPLY = process.argv.includes('--apply');

const physical = await prisma.category.findFirst({
  where: { storeId: STORE_ID, slug: 'best-sellers', deletedAt: null },
  select: {
    id: true,
    name: true,
    nameAr: true,
    _count: { select: { products: true } },
  },
});

if (!physical) {
  console.log('No active physical best-sellers category — nothing to do.');
  await prisma.$disconnect();
  process.exit(0);
}

console.log(
  `Found physical category: ${physical.id} (${physical.nameAr || physical.name}) with ${physical._count.products} product link(s).`
);

if (!APPLY) {
  console.log('DRY RUN — pass --apply to soft-delete.');
  await prisma.$disconnect();
  process.exit(0);
}

await prisma.$transaction(async tx => {
  // Drop the ProductCategory links first. Products are already in
  // their real categories (Palestinian / Spices / etc.) — the
  // best-sellers links were either empty (the merchant had marked
  // best-sellers as "fill later") or vestigial.
  await tx.productCategory.deleteMany({ where: { categoryId: physical.id } });
  await tx.category.update({
    where: { id: physical.id },
    data: { deletedAt: new Date(), isActive: false },
  });
});

console.log('✓ Soft-deleted. Bust the storefront cache to see the virtual entry.');
await prisma.$disconnect();
