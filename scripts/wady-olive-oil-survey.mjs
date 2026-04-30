// Find every olive-oil product in Wady Aljuz so we can decide which
// becomes the parent and which fold as variants.
import { prisma } from '@force/database';

const STORE_ID = 'dfc1c208-1c30-4eba-9821-6f3be15e3506';

const products = await prisma.product.findMany({
  where: {
    storeId: STORE_ID,
    deletedAt: null,
    OR: [
      { nameAr: { contains: 'زيت زيتون' } },
      { nameAr: { contains: 'زيت زيت' } },
      { name: { contains: 'olive oil', mode: 'insensitive' } },
      { name: { contains: 'olive', mode: 'insensitive' } },
    ],
  },
  orderBy: { sku: 'asc' },
  select: {
    id: true,
    sku: true,
    name: true,
    nameAr: true,
    description: true,
    descriptionAr: true,
    price: true,
    compareAtPrice: true,
    inventory: true,
    weight: true,
    hasVariants: true,
    images: { orderBy: { position: 'asc' }, select: { url: true } },
    variants: {
      select: {
        id: true,
        title: true,
        titleAr: true,
        sku: true,
        price: true,
        inventory: true,
        isActive: true,
      },
    },
  },
});

console.log(`Olive oil products: ${products.length}\n`);
for (const p of products) {
  console.log(
    `  ${p.sku?.padEnd(8) || '-'}  ${(p.nameAr || p.name || '').padEnd(35)}  ${(p.price / 1000).toFixed(3).padStart(7)} KWD  inv=${String(p.inventory).padStart(3)}  hasVariants=${p.hasVariants}  imgs=${p.images.length}`
  );
  if (p.descriptionAr) {
    console.log(`            desc: ${p.descriptionAr.slice(0, 70)}`);
  }
  for (const v of p.variants) {
    console.log(
      `            ↳ variant ${v.titleAr || v.title}  ${(v.price ? (v.price / 1000).toFixed(3) : '—').padStart(7)} KWD  inv=${v.inventory}  active=${v.isActive}`
    );
  }
}

await prisma.$disconnect();
