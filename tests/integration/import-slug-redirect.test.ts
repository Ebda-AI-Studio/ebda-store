/**
 * Bulk Import Slug Redirect — Integration Tests
 *
 * Reproduces the real-world pecannbee case: a merchant re-exports their
 * catalog from a source system with a different (usually longer,
 * auto-numbered) handle for a SKU that already exists in the store. Bulk
 * import matches the row by SKU and, in Phase 4, writes the NEW incoming
 * slug onto the existing product (bulk.service.ts `productFields.slug`).
 * That is a live rename exactly like a manual product-slug edit, so it
 * must record a SlugRedirect old (existing) slug -> new (incoming) slug,
 * the same as Task 4's manual-edit capture.
 *
 * Non-destructive: creates its own user + store in beforeAll and removes
 * exactly those rows (cascade) in afterAll. No TRUNCATE.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma, SlugEntityType } from '@force/database';
import { BulkService } from '../../apps/api/src/services/bulk.service';

const SUFFIX = `import-slug-redirect-${Date.now()}`;
let userId: string;
let storeId: string;

beforeAll(async () => {
  const user = await prisma.user.create({
    data: {
      email: `${SUFFIX}@test.local`,
      passwordHash: 'x',
      firstName: 'Import',
      lastName: 'SlugRedirect',
      role: 'store_admin',
      emailVerified: true,
    },
  });
  userId = user.id;

  const store = await prisma.store.create({
    data: {
      name: 'Import Slug Redirect Test Store',
      slug: `store-${SUFFIX}`,
      ownerId: userId,
      plan: 'enterprise',
      status: 'active',
    },
  });
  storeId = store.id;
});

afterAll(async () => {
  await prisma.slugRedirect.deleteMany({ where: { storeId } });
  await prisma.product.deleteMany({ where: { storeId } });
  await prisma.store.deleteMany({ where: { id: storeId } });
  await prisma.user.deleteMany({ where: { id: userId } });
  await prisma.$disconnect();
});

describe('bulk import records product-handle changes as redirects', () => {
  it('imports a new product at its given slug (baseline)', async () => {
    const csv = ['name,sku,price,slug', 'Raw Pecan,PEC-1,5000,raw-pecan-2636297'].join('\n');

    const result = await BulkService.importProducts(storeId, csv, { updateExisting: true }, userId);
    expect(result.failed).toBe(0);
    expect(result.created).toBe(1);

    const product = await prisma.product.findFirst({ where: { storeId, sku: 'PEC-1' } });
    expect(product?.slug).toBe('raw-pecan-2636297');
  });

  it('re-importing the same sku with a different slug renames the product and records a redirect', async () => {
    // RED (pre-wiring): no redirect row exists yet for the old handle.
    const before = await prisma.slugRedirect.findFirst({
      where: { storeId, entityType: SlugEntityType.PRODUCT, fromSlug: 'raw-pecan-2636297' },
    });
    expect(before).toBeNull();

    const csv = ['name,sku,price,slug', 'Raw Pecan,PEC-1,5000,raw-pecan'].join('\n');

    const result = await BulkService.importProducts(storeId, csv, { updateExisting: true }, userId);
    expect(result.failed).toBe(0);
    expect(result.updated).toBe(1);

    const product = await prisma.product.findFirst({ where: { storeId, sku: 'PEC-1' } });
    expect(product?.slug).toBe('raw-pecan');

    const redirect = await prisma.slugRedirect.findFirst({
      where: { storeId, entityType: SlugEntityType.PRODUCT, fromSlug: 'raw-pecan-2636297' },
    });
    expect(redirect?.toSlug).toBe('raw-pecan');
  });

  it('re-importing with an unchanged slug records no new redirect', async () => {
    const before = await prisma.slugRedirect.count({
      where: { storeId, entityType: SlugEntityType.PRODUCT },
    });

    const csv = ['name,sku,price,slug', 'Raw Pecan,PEC-1,5200,raw-pecan'].join('\n');
    const result = await BulkService.importProducts(storeId, csv, { updateExisting: true }, userId);
    expect(result.failed).toBe(0);
    expect(result.updated).toBe(1);

    const after = await prisma.slugRedirect.count({
      where: { storeId, entityType: SlugEntityType.PRODUCT },
    });
    expect(after).toBe(before);

    const product = await prisma.product.findFirst({ where: { storeId, sku: 'PEC-1' } });
    expect(product?.slug).toBe('raw-pecan');
    expect(product?.price).toBe(5200);
  });
});
