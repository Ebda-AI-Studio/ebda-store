/**
 * STORE-QA-64 on the StoreDO backend: production stores run on a Durable Object (Postgres is removed, a prisma call in the Worker
 * throws POSTGRES_REMOVED), so the Postgres round-trip in tests/integration proves a different driver. This test runs the REAL
 * BulkService (export, preview dry run, import) with its store clients wired to the DO schema on SQLite: reads and category/tag
 * writes through prisma-lite, the import batches through the DO's own `runMoneyOp('importBatch' | 'importVariants')`.
 * What it proves: DO schema + prisma-lite reads + DO import ops. What it does not: workerd itself (apps/api/workers-do lane).
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { openSqlite, META } from '../../packages/repo/test/diff-harness';
import { nodeSqlRunner } from '../../packages/repo/test/node-sql';
import { nodeSyncSql } from '../../packages/repo/test/node-sync-sql';
import { createPrismaLite } from '../../packages/repo/src/prisma-lite/client';
import { runMoneyOp, ensureMoneyOpsSchema } from '../../packages/repo/src/do/money-ops';

const raw = openSqlite();
const sync = nodeSyncSql(raw);
const lite = createPrismaLite(META, nodeSqlRunner(raw), 'store-do', { unscoped: true });
const STORE = 'do-store-1';

vi.mock('../../apps/api/src/lib/repo-factory', () => ({
  storeDb: async () => lite,
  storeWriter: async () => lite,
  storeMoney: async () => ({
    importBatch: async (a: unknown) => runMoneyOp(sync, STORE, 'importBatch', a),
    importVariants: async (a: unknown) => runMoneyOp(sync, STORE, 'importVariants', a),
  }),
}));
vi.mock('../../apps/api/src/services/plan-limit.service', () => ({
  assertWithinLimit: async () => undefined,
}));
vi.mock('../../apps/api/src/services/slug-redirect.service', () => ({
  recordSlugRedirect: async () => undefined,
}));
vi.mock('../../apps/api/src/services/barcode.service', () => ({
  fillMissingAfterImport: async () => undefined,
  lockStoreBarcodes: async () => {
    throw new Error('POSTGRES_REMOVED: the DO path must never take the advisory lock');
  },
}));
vi.mock('../../apps/api/src/lib/search/reindex', () => ({
  requestStoreReindex: async () => undefined,
}));

import { BulkService } from '../../apps/api/src/services/bulk.service';
import { importCsvToPlatformCsv } from '../../apps/api/src/services/csv-import';
import {
  buildImportPreview,
  mergeImportCheckErrors,
} from '../../apps/api/src/services/import-preview';

const count = (sql: string) => (raw.prepare(sql).get() as { n: number }).n;

beforeAll(async () => {
  ensureMoneyOpsSchema(sync);
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
  const r = await BulkService.importProducts(STORE, seed, { updateExisting: true }, 'u1');
  expect(r.errors).toEqual([]);
  expect(r.failed).toBe(0);
});

describe('export -> unchanged re-import on the StoreDO backend', () => {
  it('preview is clean; the import fails nothing, creates nothing, duplicates nothing', async () => {
    const exported = await BulkService.exportProducts(STORE);
    // sku-less product's variant rows carry the slug key, not a blank parentSku
    expect(exported).toContain('slug:ring');
    const csv = importCsvToPlatformCsv(exported).csv;

    const checked = await BulkService.importProducts(STORE, csv, {
      updateExisting: true,
      dryRun: true,
    });
    expect(checked.errors).toEqual([]);
    expect(mergeImportCheckErrors(buildImportPreview(csv), checked.errors).invalidRows).toBe(0);

    const products = count('SELECT COUNT(*) n FROM products');
    const variants = count('SELECT COUNT(*) n FROM product_variants');
    const res = await BulkService.importProducts(STORE, csv, { updateExisting: true }, 'u1');
    expect(res.errors).toEqual([]);
    expect(res.failed).toBe(0);
    expect(res.created).toBe(0);
    expect(count('SELECT COUNT(*) n FROM products')).toBe(products);
    expect(count('SELECT COUNT(*) n FROM product_variants')).toBe(variants);
    expect(count("SELECT COUNT(*) n FROM products WHERE barcode = '6223000000014'")).toBe(1);
    expect(count("SELECT COUNT(*) n FROM product_variants WHERE barcode = '6223000000045'")).toBe(
      1
    );
  });

  it("an item's own barcode is not a collision, another product's is (dry run on the DO)", async () => {
    const bad = [
      'name,slug,sku,price,barcode,inventory,status',
      'Thief,thief,THIEF-1,1000,6223000000014,1,active',
    ].join('\n');
    const checked = await BulkService.importProducts(STORE, bad, {
      updateExisting: true,
      dryRun: true,
    });
    expect(checked.errors.map(e => e.error).join()).toMatch(/already belongs to another product/);
  });
});
