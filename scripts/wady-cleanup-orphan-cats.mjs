// Variant siblings got soft-deleted (Product.deletedAt) but their
// ProductCategory rows linger, inflating per-category counts in the
// admin. The storefront filters on Product.deletedAt:null + status,
// so customers don't see them — this is a cosmetic admin-side fix.
import { prisma } from '@force/database';

const STORE_ID = 'dfc1c208-1c30-4eba-9821-6f3be15e3506';
const APPLY = process.argv.includes('--apply');

const orphans = await prisma.productCategory.findMany({
  where: {
    category: { storeId: STORE_ID },
    product: { deletedAt: { not: null } },
  },
  select: { productId: true, categoryId: true },
});

console.log(`Found ${orphans.length} orphan ProductCategory rows.`);

if (orphans.length === 0) {
  await prisma.$disconnect();
  process.exit(0);
}

if (!APPLY) {
  console.log('DRY RUN — pass --apply to delete.');
  await prisma.$disconnect();
  process.exit(0);
}

const result = await prisma.productCategory.deleteMany({
  where: {
    category: { storeId: STORE_ID },
    product: { deletedAt: { not: null } },
  },
});
console.log(`Deleted ${result.count} orphan rows.`);
await prisma.$disconnect();
