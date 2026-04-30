import { prisma } from '@force/database';
const STORE_ID = 'dfc1c208-1c30-4eba-9821-6f3be15e3506';
const parents = await prisma.product.findMany({
  where: { storeId: STORE_ID, deletedAt: null, hasVariants: true },
  orderBy: { name: 'asc' },
  select: {
    id: true,
    name: true,
    nameAr: true,
    sku: true,
    variants: { select: { id: true, title: true, titleAr: true, sku: true } },
    options: { select: { id: true, name: true, values: { select: { value: true } } } },
  },
});
for (const p of parents) {
  console.log(
    `${p.sku?.padEnd(8) || '-'} ${(p.nameAr || p.name || '').slice(0, 25).padEnd(25)} ` +
      `variants=${p.variants.length} opts=${p.options.length}` +
      `${p.variants.length > 3 ? ' ⚠' : ''}`
  );
  if (p.variants.length > 3) {
    for (const v of p.variants) console.log(`     variant: ${v.sku || '-'}  ${v.titleAr || v.title}`);
  }
}
await prisma.$disconnect();
