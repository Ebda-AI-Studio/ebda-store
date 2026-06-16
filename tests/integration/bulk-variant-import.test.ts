/**
 * Bulk Variant Import — Integration Tests
 *
 * Exercises BulkService.importProducts against a real database, verifying that
 * variant rows (parentSku + option columns) build the full ProductOption /
 * ProductOptionValue / ProductVariant / ProductVariantOption graph and flip
 * Product.hasVariants.
 *
 * Non-destructive: creates its own user + store in beforeAll and removes
 * exactly those rows (cascade) in afterAll. No TRUNCATE. The prod-DB guard in
 * tests/setup-e2e.ts additionally refuses to run against production.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma } from '@force/database';
import { BulkService } from '../../apps/api/src/services/bulk.service';

const SUFFIX = `variant-import-${Date.now()}`;
let userId: string;
let storeId: string;

beforeAll(async () => {
  const user = await prisma.user.create({
    data: {
      email: `${SUFFIX}@test.local`,
      passwordHash: 'x',
      firstName: 'Variant',
      lastName: 'Import',
      role: 'store_admin',
      emailVerified: true,
    },
  });
  userId = user.id;

  const store = await prisma.store.create({
    data: {
      name: 'Variant Import Test Store',
      slug: `store-${SUFFIX}`,
      ownerId: userId,
      plan: 'enterprise',
      status: 'active',
    },
  });
  storeId = store.id;
});

afterAll(async () => {
  await prisma.product.deleteMany({ where: { storeId } });
  await prisma.store.deleteMany({ where: { id: storeId } });
  await prisma.user.deleteMany({ where: { id: userId } });
  await prisma.$disconnect();
});

describe('bulk import with variants', () => {
  it('creates a product with a Size option and three size variants', async () => {
    const csv = [
      'name,nameAr,sku,price,barcode,inventory,categories,images,parentSku,option1Name,option1Value',
      'Salted Sunflower,الحب الشمسي,SUN,1250,SUN,0,Nuts,https://example.com/sun.jpg,,,',
      ',,SUN-1kg,2500,SUN1,40,,,SUN,Size,1 Kg',
      ',,SUN-500g,1500,SUN2,60,,,SUN,Size,500 Gram',
      ',,SUN-250g,1000,SUN3,80,,,SUN,Size,250 Gram',
    ].join('\n');

    const result = await BulkService.importProducts(storeId, csv, { updateExisting: true }, userId);

    expect(result.created).toBe(1); // one base product
    expect(result.variantsCreated).toBe(3);
    expect(result.failed).toBe(0);

    const product = await prisma.product.findFirst({
      where: { storeId, sku: 'SUN' },
      include: {
        options: { include: { values: true } },
        variants: { include: { options: true } },
      },
    });
    expect(product?.hasVariants).toBe(true);
    expect(product?.options).toHaveLength(1);
    expect(product?.options[0].name).toBe('Size');
    expect(product?.options[0].values.map(v => v.value).sort()).toEqual([
      '1 Kg',
      '250 Gram',
      '500 Gram',
    ]);
    expect(product?.variants).toHaveLength(3);

    const oneKg = product?.variants.find(v => v.sku === 'SUN-1kg');
    expect(oneKg?.price).toBe(2500);
    expect(oneKg?.inventory).toBe(40);
    expect(oneKg?.title).toBe('1 Kg');
    expect(oneKg?.options).toHaveLength(1); // junction row links to the value
  });

  it('re-import with updateExisting rebuilds variants without duplicating', async () => {
    const csv = [
      'name,sku,price,parentSku,option1Name,option1Value',
      'Salted Sunflower,SUN,1250,,,',
      ',SUN-1kg,2600,SUN,Size,1 Kg',
    ].join('\n');

    const result = await BulkService.importProducts(storeId, csv, { updateExisting: true }, userId);
    expect(result.failed).toBe(0);

    const variants = await prisma.productVariant.findMany({
      where: { product: { storeId, sku: 'SUN' } },
    });
    expect(variants).toHaveLength(1); // rebuilt, not appended to the previous 3
    expect(variants[0].price).toBe(2600);
  });

  it('imports a product whose description contains an embedded newline as ONE product', async () => {
    const csv = [
      'name,sku,price,description',
      `Sidr Honey,HONEY-${SUFFIX},20000,"premium sidr honey\nharvested in season"`,
    ].join('\n');

    const result = await BulkService.importProducts(storeId, csv, { updateExisting: true }, userId);
    expect(result.created).toBe(1);
    expect(result.failed).toBe(0);

    const p = await prisma.product.findFirst({ where: { storeId, sku: `HONEY-${SUFFIX}` } });
    expect(p?.description).toContain('harvested in season');
  });

  it('flat products with no variant columns still import unchanged (backward compat)', async () => {
    const csv = ['name,sku,price,inventory', `Plain Dates,PLAIN-${SUFFIX},3000,12`].join('\n');

    const result = await BulkService.importProducts(storeId, csv, { updateExisting: true }, userId);
    expect(result.created).toBe(1);
    expect(result.variantsCreated).toBe(0);
    expect(result.failed).toBe(0);

    const p = await prisma.product.findFirst({ where: { storeId, sku: `PLAIN-${SUFFIX}` } });
    expect(p?.hasVariants).toBe(false);
    expect(p?.price).toBe(3000);
  });

  it('export round-trips variants (parentSku + option columns present)', async () => {
    const csv = await BulkService.exportProducts(storeId);
    const header = csv.split('\n')[0];
    expect(header).toContain('parentSku');
    expect(header).toContain('option1Name');
    // The SUN product (imported above) has a 1 Kg variant referencing parentSku=SUN.
    expect(csv).toContain('SUN,Size,1 Kg');
  });
});
