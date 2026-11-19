/**
 * STORE-QA-64: export -> re-import of the SAME file must change nothing and fail nothing.
 * Real database. Own user + store, removed in afterAll (cascade). No TRUNCATE.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma } from '@ebda/database';
import { BulkService } from '../../apps/api/src/services/bulk.service';
import { importCsvToPlatformCsv } from '../../apps/api/src/services/csv-import';
import {
  buildImportPreview,
  mergeImportCheckErrors,
} from '../../apps/api/src/services/import-preview';

const SUFFIX = `roundtrip-${Date.now()}`;
let userId: string;
let storeId: string;

beforeAll(async () => {
  const user = await prisma.user.create({
    data: {
      email: `${SUFFIX}@test.local`,
      passwordHash: 'x',
      firstName: 'Round',
      lastName: 'Trip',
      role: 'store_admin',
      emailVerified: true,
    },
  });
  userId = user.id;
  const store = await prisma.store.create({
    data: {
      name: 'Roundtrip Store',
      slug: `store-${SUFFIX}`,
      ownerId: userId,
      plan: 'enterprise',
      status: 'active',
    },
  });
  storeId = store.id;
  // seed through the importer: a barcoded plain product, a SKU'd variant product, and a variant product WITHOUT a sku
  const seed = [
    'name,slug,sku,price,barcode,inventory,status,parentSku,option1Name,option1Value',
    'Plain,plain,PLAIN-1,1000,6223000000014,5,active,,,',
    'Shirt,shirt,SHIRT-1,2000,,0,active,,,',
    ',,SHIRT-S,2000,6223000000021,3,active,SHIRT-1,Size,Small',
    ',,SHIRT-L,2000,6223000000038,4,active,SHIRT-1,Size,Large',
    'Ring,ring,,3000,,0,active,,,',
    ',,,3000,6223000000045,7,active,slug:ring,Size,7',
    ',,,3000,6223000000052,8,active,slug:ring,Size,8',
  ].join('\n');
  const r = await BulkService.importProducts(storeId, seed, { updateExisting: true }, userId);
  expect(r.failed).toBe(0);
});

afterAll(async () => {
  await prisma.product.deleteMany({ where: { storeId } });
  await prisma.store.deleteMany({ where: { id: storeId } });
  await prisma.user.deleteMany({ where: { id: userId } });
  await prisma.$disconnect();
});

describe('export -> unchanged re-import', () => {
  it('preview is clean, the import fails nothing and duplicates nothing', async () => {
    const exported = await BulkService.exportProducts(storeId);
    const csv = importCsvToPlatformCsv(exported).csv;

    const checked = await BulkService.importProducts(storeId, csv, {
      updateExisting: true,
      dryRun: true,
    });
    expect(checked.errors).toEqual([]);
    const preview = mergeImportCheckErrors(buildImportPreview(csv), checked.errors);
    expect(preview.invalidRows).toBe(0);

    const before = await prisma.product.count({ where: { storeId } });
    const beforeVariants = await prisma.productVariant.count({ where: { product: { storeId } } });
    const res = await BulkService.importProducts(storeId, csv, { updateExisting: true }, userId);
    expect(res.errors).toEqual([]);
    expect(res.failed).toBe(0);
    expect(res.created).toBe(0);
    expect(await prisma.product.count({ where: { storeId } })).toBe(before);
    expect(await prisma.productVariant.count({ where: { product: { storeId } } })).toBe(
      beforeVariants
    );
  });

  it('the preview flags a barcode that belongs to another product (no green preview over a failing import)', async () => {
    const bad = [
      'name,slug,sku,price,barcode,inventory,status',
      'Thief,thief,THIEF-1,1000,6223000000014,1,active',
    ].join('\n');
    const checked = await BulkService.importProducts(storeId, bad, {
      updateExisting: true,
      dryRun: true,
    });
    expect(checked.errors.map(e => e.error).join()).toMatch(/already belongs to another product/);
    expect(mergeImportCheckErrors(buildImportPreview(bad), checked.errors).invalidRows).toBe(1);
  });
});
