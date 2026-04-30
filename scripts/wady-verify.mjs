// Post-apply verification: per-bucket count of ProductCategory rows
// vs count of "active" products in each bucket. The storefront
// filters for deletedAt:null + status:active, so the active count is
// what the customer actually sees. The total includes soft-deleted
// rows (variant siblings) which we shouldn't be exposing.
//
// Also reports any orphaned ProductCategory rows pointing at
// soft-deleted siblings — those should be deleted.
import { prisma } from '@force/database';

const STORE_ID = 'dfc1c208-1c30-4eba-9821-6f3be15e3506';

const cats = await prisma.category.findMany({
  where: { storeId: STORE_ID, deletedAt: null },
  orderBy: { position: 'asc' },
  select: { id: true, slug: true, nameAr: true },
});

console.log('Per-bucket counts:');
let orphanLinks = 0;
for (const c of cats) {
  const total = await prisma.productCategory.count({ where: { categoryId: c.id } });
  const active = await prisma.productCategory.count({
    where: {
      categoryId: c.id,
      product: { deletedAt: null, status: 'active' },
    },
  });
  const orphaned = total - active;
  orphanLinks += orphaned;
  const flag = orphaned > 0 ? ' ⚠' : '';
  console.log(
    `  ${c.slug.padEnd(20)} ${(c.nameAr || '').padEnd(28)}  total=${total}  storefront=${active}${flag}`
  );
}
console.log(`\nOrphaned ProductCategory rows (pointing at soft-deleted products): ${orphanLinks}`);

const variantParents = await prisma.product.count({
  where: { storeId: STORE_ID, deletedAt: null, hasVariants: true },
});
const variantRows = await prisma.productVariant.count({
  where: { product: { storeId: STORE_ID, deletedAt: null } },
});
console.log(`\nVariant parents: ${variantParents}`);
console.log(`Variant rows:    ${variantRows}`);

await prisma.$disconnect();
