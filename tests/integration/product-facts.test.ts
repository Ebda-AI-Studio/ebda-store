/**
 * Product facts round-trip through the real ProductService + DB (RLS path),
 * and the DB CHECK rejects a non-array value.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma, runInTenantContext } from '@ebda/database';
import { ProductService } from '../../apps/api/src/services/product.service';
import { updateProductSchema } from '../../apps/api/src/routes/product.routes';

const EMAIL = `product-facts-test-${Date.now()}@example.test`;
let STORE = '';
let userId = '';
let productId = '';

const row = (n: number, onCard = false) => ({
  key: `Key ${n}`,
  keyAr: `مفتاح ${n}`,
  value: `Value ${n}`,
  valueAr: `قيمة ${n}`,
  onCard,
});

describe('product facts persistence', () => {
  beforeAll(async () => {
    const user = await prisma.user.create({
      data: {
        email: EMAIL,
        passwordHash: 'hashed',
        firstName: 'Product',
        lastName: 'Facts',
        role: 'store_admin',
        status: 'active',
        emailVerified: true,
      },
    });
    userId = user.id;
    const store = await prisma.store.create({
      data: {
        name: 'Product Facts Test Store',
        slug: `product-facts-test-store-${Date.now()}`,
        ownerId: user.id,
        status: 'active',
      },
    });
    STORE = store.id;
    const p = await runInTenantContext(STORE, () =>
      ProductService.create(STORE, { name: 'Linen Abaya', price: 1000 })
    );
    productId = p.id;
  });

  afterAll(async () => {
    await prisma.bulkAiJob.deleteMany({ where: { storeId: STORE } });
    await prisma.product.deleteMany({ where: { storeId: STORE } });
    await prisma.store.deleteMany({ where: { id: STORE } });
    await prisma.user.deleteMany({ where: { id: userId } });
    await prisma.$disconnect();
  });

  it('defaults to an empty array', async () => {
    const p = await runInTenantContext(STORE, () => ProductService.getById(STORE, productId));
    expect((p as any).facts).toEqual([]);
  });

  it('PUT with 3 rows -> GET returns them in order; omitted key leaves them alone', async () => {
    const facts = [row(1, true), row(2), row(3)];
    const parsed = updateProductSchema.parse({ facts });
    await runInTenantContext(STORE, () => ProductService.update(STORE, productId, parsed));
    await runInTenantContext(STORE, () =>
      ProductService.update(STORE, productId, { name: 'Linen Abaya 2' })
    );
    const p = await runInTenantContext(STORE, () => ProductService.getById(STORE, productId));
    expect((p as any).facts).toEqual(facts);
  });

  it('25 rows is rejected at the edge (400)', () => {
    const r = updateProductSchema.safeParse({
      facts: Array.from({ length: 25 }, (_, i) => row(i)),
    });
    expect(r.success).toBe(false);
  });

  it('the DB CHECK rejects a non-array facts value', async () => {
    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE products SET facts = '{"a":1}'::jsonb WHERE id = '${productId}'`
      )
    ).rejects.toThrow();
  });
});
