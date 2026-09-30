/**
 * Issue 2048 — the duplicate-SKU import guard (#1029) only tracked CREATE
 * rows. Phase 4 writes `sku` on updates too, so two rows slug-matched to two
 * DIFFERENT existing products both claiming one SKU hit the (storeId, sku)
 * unique index inside the batch transaction and rolled back every row of the
 * batch — unrelated products included.
 *
 * Mutation proof: in bulk.service.ts restore the `if (row.sku && !existing)`
 * gate → the second row reaches Phase 4, the batch aborts, and `updated`
 * drops to 0 while `failed` counts the whole batch.
 *
 * Fixtures are per-CALL (retry-safe).
 */
import { describe, it, expect, afterAll } from 'vitest';
import crypto from 'crypto';
import { prisma } from '@force/database';
import { BulkService } from '../../apps/api/src/services/bulk.service';

const hasDb =
  !!process.env.DATABASE_URL && !process.env.DATABASE_URL.includes('localhost:5432/test_db');

const created: { storeIds: string[]; userIds: string[] } = { storeIds: [], userIds: [] };

async function seedStore() {
  const uniq = crypto.randomUUID().slice(0, 12);
  const user = await prisma.user.create({
    data: {
      email: `dupsku-${uniq}@test.local`,
      passwordHash: 'x',
      firstName: 'Dup',
      lastName: 'Sku',
      role: 'store_admin',
    },
  });
  const store = await prisma.store.create({
    data: { name: 'dupsku', slug: `dupsku-${uniq}`, ownerId: user.id, status: 'active' },
  });
  created.userIds.push(user.id);
  created.storeIds.push(store.id);
  const product = (slug: string) =>
    prisma.product.create({
      data: { storeId: store.id, name: slug, slug, price: 1000, sku: null },
    });
  await product('alpha');
  await product('beta');
  return { storeId: store.id, userId: user.id };
}

afterAll(async () => {
  if (!hasDb) return;
  await prisma.product.deleteMany({ where: { storeId: { in: created.storeIds } } });
  await prisma.store.deleteMany({ where: { id: { in: created.storeIds } } });
  await prisma.user.deleteMany({ where: { id: { in: created.userIds } } });
});

describe.skipIf(!hasDb)('bulk import — duplicate SKU on the UPDATE path (issue 2048)', () => {
  it('fails only the second row that claims a SKU for a different existing product', async () => {
    const { storeId, userId } = await seedStore();
    const csv = [
      'name,slug,sku,price',
      'Alpha,alpha,SHARED-1,1100',
      'Beta,beta,SHARED-1,1200',
      'Gamma,gamma,G-1,1300',
    ].join('\n');

    const result = await BulkService.importProducts(storeId, csv, { updateExisting: true }, userId);

    expect(result.failed).toBe(1);
    expect(result.errors).toEqual([
      expect.objectContaining({ row: 3, error: 'Duplicate SKU "SHARED-1" within this import' }),
    ]);
    // The rest of the batch landed.
    expect(result.updated).toBe(1);
    expect(result.created).toBe(1);
    const skus = await prisma.product.findMany({
      where: { storeId },
      select: { slug: true, sku: true },
      orderBy: { slug: 'asc' },
    });
    expect(skus).toEqual([
      { slug: 'alpha', sku: 'SHARED-1' },
      { slug: 'beta', sku: null },
      { slug: 'gamma', sku: 'G-1' },
    ]);
  });

  it('the same product re-asserting its own SKU on two rows is not a collision', async () => {
    const { storeId, userId } = await seedStore();
    const csv = ['name,slug,sku,price', 'Alpha,alpha,A-1,1100', 'Alpha 2,alpha,A-1,1150'].join(
      '\n'
    );
    const result = await BulkService.importProducts(storeId, csv, { updateExisting: true }, userId);
    expect(result.failed).toBe(0);
  });
});
