// Snapshot of Wady Aljuz's current categories + products, used as
// input for the category-rebucket and variant-merge passes.
//
// Writes:
//   /tmp/wady-categories.json — all categories (current set)
//   /tmp/wady-products.json   — all products with current cat links
import { prisma } from '@force/database';
import { writeFileSync } from 'fs';

const STORE_ID = 'dfc1c208-1c30-4eba-9821-6f3be15e3506';

const cats = await prisma.category.findMany({
  where: { storeId: STORE_ID, deletedAt: null },
  orderBy: { position: 'asc' },
  select: {
    id: true,
    name: true,
    nameAr: true,
    slug: true,
    description: true,
    descriptionAr: true,
    isActive: true,
    position: true,
    _count: { select: { products: true } },
  },
});

const products = await prisma.product.findMany({
  where: { storeId: STORE_ID, deletedAt: null },
  orderBy: { name: 'asc' },
  select: {
    id: true,
    name: true,
    nameAr: true,
    slug: true,
    sku: true,
    price: true,
    compareAtPrice: true,
    costPrice: true,
    inventory: true,
    weight: true,
    status: true,
    featured: true,
    isBestSeller: true,
    description: true,
    descriptionAr: true,
    hasVariants: true,
    categories: { select: { categoryId: true } },
    images: { orderBy: { position: 'asc' }, select: { url: true, alt: true, position: true } },
    variants: {
      select: {
        id: true,
        title: true,
        titleAr: true,
        sku: true,
        price: true,
        inventory: true,
      },
    },
  },
});

writeFileSync('/tmp/wady-categories.json', JSON.stringify(cats, null, 2));
writeFileSync('/tmp/wady-products.json', JSON.stringify(products, null, 2));

console.log(`Categories: ${cats.length}`);
console.log(`Products:   ${products.length}`);
console.log(`Snapshots written to /tmp/wady-categories.json and /tmp/wady-products.json`);

await prisma.$disconnect();
