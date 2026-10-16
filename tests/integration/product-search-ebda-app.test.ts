/**
 * The rewritten admin-side search paths (search program P0, Task 3) run the way production runs
 * them: one guarded app client (`createPrismaClient`, tenant guard R-EBDA-003/004) on the
 * strict-RLS role `ebda_app` (R-EBDA-001), bound per request with `runWithRequestDb`, inside the
 * store's tenant context (what `tenantContext` middleware opens). The in-process suites run as
 * the OWNER role (no guard, BYPASSRLS), so only this file proves that the new raw SQL is neither
 * refused by the guard nor able to see another store.
 *
 * Paths: admin product list, CSV export, warehouse stock search, promotion list, bundle name
 * search. Store B holds the SAME names, so a leak would show up as B's ids.
 */
import crypto from 'crypto';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { prisma, createPrismaClient, runWithRequestDb, runInTenantContext } from '@ebda/database';
import { hasDb } from '../helpers/bundle-fixtures';

vi.mock('../../apps/api/src/lib/inngest/client', () => ({
  inngest: { send: vi.fn(async () => ({ ids: [] })), createFunction: vi.fn(() => ({})) },
}));
const { searchNameIds } = await import('../../apps/api/src/services/product-search.service');
const { ProductService } = await import('../../apps/api/src/services/product.service');
const { BulkService } = await import('../../apps/api/src/services/bulk.service');
const { PromotionService } = await import('../../apps/api/src/services/promotion.service');
const { WarehouseService } = await import('../../apps/api/src/services/warehouse.service');

const OWNER_URL = process.env.DIRECT_URL || process.env.DATABASE_URL || '';
function appUrl(): string {
  const u = new URL(OWNER_URL);
  u.username = 'ebda_app';
  u.password = process.env.EBDA_APP_PASSWORD || 'ci-only-app-pw';
  return u.toString();
}
/** One request: the guarded ebda_app client, inside the store's tenant context. */
const asAppIn = <T>(storeId: string, fn: () => Promise<T>) =>
  runWithRequestDb(
    () => createPrismaClient({ connectionString: appUrl(), max: 2 }),
    () => runInTenantContext(storeId, fn)
  );

const run = crypto.randomUUID().slice(0, 8);
const ownerIds: string[] = [];
type Fixture = {
  storeId: string;
  productId: string;
  promotionId: string;
  bundleId: string;
  warehouseId: string;
};
const A = {} as Fixture;
const B = {} as Fixture;

async function mkFixture(tag: string, f: Fixture) {
  const owner = await prisma.user.create({
    data: {
      email: `pse-${tag}-${run}@t.local`,
      passwordHash: 'x',
      firstName: 'Pse',
      lastName: 'Owner',
      role: 'store_admin',
    },
  });
  ownerIds.push(owner.id);
  const slug = `pse-${tag}-${run}`;
  f.storeId = (await prisma.store.create({ data: { name: slug, slug, ownerId: owner.id } })).id;
  f.productId = (
    await prisma.product.create({
      data: {
        storeId: f.storeId,
        slug: `shoes-${run}`,
        name: `Leather shoes ${run}`,
        nameAr: `أحذية جلد ${run}`,
        sku: `MUG-٧٧-${run}`,
        price: 1000,
        status: 'active',
      },
    })
  ).id;
  f.promotionId = (
    await prisma.promotion.create({
      data: { storeId: f.storeId, name: `Eid ${run}`, nameAr: `عرض الطرحة ${run}`, value: 10 },
    })
  ).id;
  f.bundleId = (
    await prisma.bundle.create({
      data: {
        storeId: f.storeId,
        name: `Set ${run}`,
        nameAr: `طقم إسدال ${run}`,
        slug: `set-${run}`,
        pricingType: 'fixed_price',
        pricingValue: 12000,
      },
    })
  ).id;
  f.warehouseId = (
    await prisma.warehouse.create({ data: { storeId: f.storeId, name: `WH ${run}`, code: 'MAIN' } })
  ).id;
  await prisma.warehouseStock.create({
    data: { storeId: f.storeId, warehouseId: f.warehouseId, productId: f.productId, quantity: 2 },
  });
}

describe.skipIf(!hasDb)('normalised search under the tenant guard + strict RLS (ebda_app)', () => {
  beforeAll(async () => {
    await mkFixture('a', A);
    await mkFixture('b', B);
  });
  afterAll(async () => {
    const stores = [A.storeId, B.storeId].filter(Boolean);
    await prisma.warehouseStock.deleteMany({ where: { storeId: { in: stores } } });
    await prisma.warehouse.deleteMany({ where: { storeId: { in: stores } } });
    await prisma.promotion.deleteMany({ where: { storeId: { in: stores } } });
    await prisma.bundle.deleteMany({ where: { storeId: { in: stores } } });
    await prisma.product.deleteMany({ where: { storeId: { in: stores } } });
    await prisma.store.deleteMany({ where: { id: { in: stores } } });
    await prisma.user.deleteMany({ where: { id: { in: ownerIds } } });
  });

  it('runs as ebda_app (not a bypass role) with the guard on', async () => {
    const [who] = await asAppIn(
      A.storeId,
      () => prisma.$queryRaw<Array<{ u: string }>>`SELECT current_user::text AS u`
    );
    expect(who.u).toBe('ebda_app');
    // The guard refuses raw SQL naming a tenant table with no ambient scope.
    await expect(
      runWithRequestDb(
        () => createPrismaClient({ connectionString: appUrl(), max: 1 }),
        () => searchNameIds('bundles', A.storeId, `اسدال ${run}`)
      )
    ).rejects.toThrow(/tenant guard: .*refused/);
  });

  it('admin product list: store A finds its own product, never B', async () => {
    const res = await asAppIn(A.storeId, () =>
      ProductService.list(A.storeId, { search: `احذيه ${run}` })
    );
    expect(res.products.map(p => p.id)).toEqual([A.productId]);
    const sku = await asAppIn(A.storeId, () =>
      ProductService.list(A.storeId, { search: `mug-77-${run}` })
    );
    expect(sku.products.map(p => p.id)).toEqual([A.productId]);
  });

  it('CSV export: only store A rows', async () => {
    const csv = await asAppIn(A.storeId, () =>
      BulkService.exportProducts(A.storeId, { search: `احذيه ${run}` })
    );
    expect(csv).toContain(A.productId);
    expect(csv).not.toContain(B.productId);
  });

  it('warehouse stock search: only store A rows', async () => {
    const res = await asAppIn(A.storeId, () =>
      WarehouseService.listWarehouseStock(A.storeId, A.warehouseId, { search: `احذيه ${run}` })
    );
    expect(res.rows.map(r => r.productId)).toEqual([A.productId]);
  });

  it('promotion list: only store A', async () => {
    const res = await asAppIn(A.storeId, () =>
      PromotionService.list(A.storeId, { search: `الطرحه ${run}` })
    );
    expect(res.promotions.map(p => p.id)).toEqual([A.promotionId]);
  });

  it('bundle name search: only store A', async () => {
    const ids = await asAppIn(A.storeId, () => searchNameIds('bundles', A.storeId, `اسدال ${run}`));
    expect(ids).toEqual([A.bundleId]);
  });

  it("naming store B's id from store A's context returns nothing (RLS), not B's rows", async () => {
    const ids = await asAppIn(A.storeId, () => searchNameIds('bundles', B.storeId, `اسدال ${run}`));
    expect(ids).toEqual([]);
  });
});
