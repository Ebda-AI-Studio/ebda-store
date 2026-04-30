import { prisma as p } from '@force/database';
const stores = await p.store.findMany({
  orderBy: { createdAt: 'asc' },
  select: {
    id: true,
    name: true,
    slug: true,
    status: true,
    createdAt: true,
    ownerId: true,
    _count: {
      select: { products: true, categories: true, orders: true, customers: true },
    },
  },
});
console.log(JSON.stringify(stores, null, 2));
await p.$disconnect();
