import { prisma } from '@force/database';
const p = await prisma.product.findFirst({
  where: { sku: 'WJ-54' },
  select: {
    id: true,
    sku: true,
    price: true,
    compareAtPrice: true,
    nameAr: true,
    hasVariants: true,
  },
});
console.log(JSON.stringify(p, null, 2));
await prisma.$disconnect();
