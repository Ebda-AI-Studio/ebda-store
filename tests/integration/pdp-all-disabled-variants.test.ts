/**
 * Issue 2147 — the PDP select pre-filtered variants to `isActive: true`, so a
 * product whose variants are ALL disabled reached `enrichStockFlags` as
 * variant-less and inherited the parent `inventory` column. A product stocked
 * at 50 as a simple product, then given variants that were all disabled, was
 * "50 in stock" on its PDP while checkout refused it.
 *
 * Mutation proof: restore `where: { isActive: true }` on
 * PUBLIC_PRODUCT_DETAIL_SELECT's variants → inventory reads 50 and this goes red.
 *
 * Fixtures are per-CALL (retry-safe).
 */
import { describe, it, expect, afterAll } from 'vitest';
import crypto from 'crypto';
import { prisma } from '@force/database';
import { ProductService } from '../../apps/api/src/services/product.service';

const hasDb =
  !!process.env.DATABASE_URL && !process.env.DATABASE_URL.includes('localhost:5432/test_db');

const created: { storeIds: string[]; userIds: string[] } = { storeIds: [], userIds: [] };

async function seed(variantsActive: boolean[]) {
  const uniq = crypto.randomUUID().slice(0, 12);
  const user = await prisma.user.create({
    data: {
      email: `pdpvar-${uniq}@test.local`,
      passwordHash: 'x',
      firstName: 'P',
      lastName: 'V',
      role: 'store_admin',
    },
  });
  const store = await prisma.store.create({
    data: { name: 'pdpvar', slug: `pdpvar-${uniq}`, ownerId: user.id, status: 'active' },
  });
  created.userIds.push(user.id);
  created.storeIds.push(store.id);
  const product = await prisma.product.create({
    data: {
      storeId: store.id,
      name: 'Abaya',
      slug: `abaya-${uniq}`,
      price: 10000,
      status: 'active',
      // Stocked as a simple product, then converted: the parent column kept 50.
      inventory: 50,
      hasVariants: true,
    },
  });
  for (const [i, isActive] of variantsActive.entries()) {
    await prisma.productVariant.create({
      data: { productId: product.id, title: `V${i}`, inventory: 5, isActive, position: i },
    });
  }
  return { storeId: store.id, slug: product.slug };
}

afterAll(async () => {
  if (!hasDb) return;
  await prisma.product.deleteMany({ where: { storeId: { in: created.storeIds } } });
  await prisma.store.deleteMany({ where: { id: { in: created.storeIds } } });
  await prisma.user.deleteMany({ where: { id: { in: created.userIds } } });
});

describe.skipIf(!hasDb)(
  'PDP stock for a product whose variants are all disabled (issue 2147)',
  () => {
    it('reads 0 / out of stock, never the parent column, and lists no variants', async () => {
      const { storeId, slug } = await seed([false, false]);
      const pdp = (await ProductService.getPublicBySlug(storeId, slug)) as Record<string, unknown>;
      expect(pdp.inventory).toBe(0);
      expect(pdp.inStock).toBe(false);
      expect(pdp.variants).toEqual([]);
    });

    it('with one active variant: stock is that variant, and only it is listed', async () => {
      const { storeId, slug } = await seed([false, true]);
      const pdp = (await ProductService.getPublicBySlug(storeId, slug)) as {
        inventory: number;
        inStock: boolean;
        variants: Array<{ name: string; inStock: boolean }>;
      };
      expect(pdp.inventory).toBe(5);
      expect(pdp.inStock).toBe(true);
      expect(pdp.variants.map(v => v.name)).toEqual(['V1']);
    });
  }
);
