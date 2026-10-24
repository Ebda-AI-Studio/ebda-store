// Prisma 6.19.3 (engineType "client": wasm QueryCompiler + driver adapter), constructed PER REQUEST
// exactly like production's createPrismaClient does. Prisma ships NO Durable Object SQLite adapter
// (see README: the only SQLite-on-Workers adapter is @prisma/adapter-d1, which targets a D1 binding
// and ignores transactions, d1-worker.ts:195). So this file runs against a D1 binding with the same
// schema. That is the BEST case for Prisma here (a custom DO adapter would add our own code on top).
import { PrismaClient } from './prisma-gen/wasm.js';
import { PrismaD1 } from '@prisma/adapter-d1';

export function makePrisma(d1: D1Database) {
  return new PrismaClient({ adapter: new PrismaD1(d1) });
}

export type Prisma = ReturnType<typeof makePrisma>;

export function listProducts(p: Prisma, storeId: string, limit: number) {
  return p.product.findMany({
    where: { storeId, status: 'active' },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });
}

export async function addCartItem(
  p: Prisma,
  storeId: string,
  sessionId: string,
  productId: string,
  qty: number
) {
  const now = Date.now();
  const product = await p.product.findFirst({ where: { id: productId, storeId } });
  if (!product || product.status !== 'active') throw new Error('PRODUCT_NOT_FOUND');
  const cart = await p.cart.upsert({
    where: { storeId_sessionId: { storeId, sessionId } },
    create: { id: crypto.randomUUID(), storeId, sessionId, createdAt: now, updatedAt: now },
    update: {},
  });
  // NOT atomic with the lines above: the D1 adapter runs "transactions" as individual queries.
  await p.cartItem.create({
    data: {
      id: crypto.randomUUID(),
      cartId: cart.id,
      storeId,
      productId,
      quantity: qty,
      unitPrice: product.price,
      createdAt: now,
    },
  });
  return { cartId: cart.id };
}
