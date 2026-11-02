/**
 * Ruling INTEG-1: the catalogue import (#329) and the Customer Intelligence hints (#336) serve a store on its Durable Object.
 * For every flow:
 *  - it reaches its store only through the DO-aware clients: the Postgres `prisma` stand-in THROWS for any store-do model, so a
 *    run that finishes proves no store row was read or written there;
 *  - where it writes, a second delivery (an at-least-once queue, a workflow replay) leaves the state of one delivery.
 * The static scan at the end keeps the sources off `prisma.<store-do model>`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { FakeStoreDo, postgresGuard } from './helpers/fake-store-do';

const DO_STORE = '09b5dbd1-1774-49b5-b781-e06d0ee7b0fe';

const h = vi.hoisted(() => ({
  platformStore: { findFirst: vi.fn(), findUnique: vi.fn(), updateMany: vi.fn() },
  money: { importBatch: vi.fn(async () => ({ variantsCreated: 2, products: [], renames: [] })) },
  productCreate: vi.fn(async () => ({ id: 'prod-1' })),
  bulkStatus: vi.fn(async () => ({ updated: 1, failed: 0, errors: [] })),
  invalidate: vi.fn(async () => undefined),
  processFile: vi.fn(),
  sendAlert: vi.fn(async () => 'sent'),
  doBox: { current: undefined as unknown as import('./helpers/fake-store-do').FakeStoreDo },
}));

vi.mock('@ebda/database', async () => {
  const { postgresGuard: guard } = await import('./helpers/fake-store-do');
  const prisma = guard({
    store: h.platformStore,
    systemSetting: { findUnique: async () => null, findMany: async () => [] },
  });
  return (await import('./helpers/database-mock')).databaseMock({
    prisma,
    defaultStoreIds: [],
    extra: {
      currentStoreId: () => DO_STORE,
      hasTenantContext: () => false,
      withoutHiddenStores: <T>(fn: () => T) => fn(),
      withHiddenStores: <T>(_s: unknown, fn: () => T) => fn(),
      storeDirectory: async (filter?: (s: Record<string, unknown>) => boolean) =>
        [
          { id: DO_STORE, name: 'Demo', slug: 'demo', status: 'active', plan: 'professional' },
        ].filter(s => (filter ? filter(s) : true)),
      acrossStores: async () => {
        throw new Error('Postgres touched: acrossStores');
      },
      withMoneyTx: async () => {
        throw new Error('Postgres touched: withMoneyTx');
      },
    },
  });
});
vi.mock('@api/lib/repo-factory', () => ({
  storeRepo: async (storeId: string) => ({
    storeId,
    backend: 'do',
    db: h.doBox.current.db,
    writer: h.doBox.current.writer,
    money: h.money,
  }),
  storeDb: async () => h.doBox.current.db,
  storeWriter: async () => h.doBox.current.writer,
  storeMoney: async () => h.money,
  storeUpdateMany: vi.fn(async () => ({ count: 1 })),
  runInJobRepoScope: <T>(fn: () => T) => fn(),
}));
vi.mock('@api/lib/inngest/client', () => ({
  inngest: {
    send: vi.fn(async () => undefined),
    createFunction: (options: unknown, handler: unknown) => ({ options, handler }),
  },
}));
vi.mock('@api/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@api/lib/public-cache', () => ({ invalidateStoreProductCaches: h.invalidate }));
vi.mock('@api/services/alerts.service', () => ({ sendAlert: h.sendAlert }));
vi.mock('@api/services/product.service', () => ({ ProductService: { create: h.productCreate } }));
vi.mock('@api/services/bulk.service', () => ({
  BulkService: { bulkUpdateStatus: h.bulkStatus },
  createVariantsForProductTx: vi.fn(async () => {
    throw new Error('Postgres touched: createVariantsForProductTx');
  }),
}));
vi.mock('@api/services/storage.service', () => ({
  StorageService: { isAvailable: () => false, privateBucket: () => 'b' },
}));
vi.mock('@api/lib/after-tenant-commit', () => ({
  deferAfterTenantCommit: (fn: () => unknown) => fn(),
}));
vi.mock('@api/services/feature.service', () => ({
  featureService: { isFeatureEnabled: async () => true },
}));
vi.mock('@api/lib/ci/hints/data', () => ({
  loadHintData: async () => ({ window: null, cohort: null, now: new Date() }),
}));
vi.mock('@api/lib/ci/hints/cod-risk', () => ({
  codRiskHint: () => ({ band: 'high', source: 'store', n: 12, rate: 0.4 }),
}));
vi.mock('@api/lib/catalogue/process-file', () => ({
  processFile: h.processFile,
  refreshJobCounters: async (storeId: string, jobId: string) => {
    const files = await h.doBox.current.db.catalogImportFile.findMany({
      where: { jobId, storeId },
    });
    return {
      done: files.filter((f: { status: string }) => f.status === 'done').length,
      failed: 0,
      skipped: 0,
    };
  },
}));

import { MONEY_JOBS, ALL_STORES_JOBS, jobDataClass } from '@api/lib/jobs/job-data';
import { decideRunForStore } from '@api/lib/jobs/do-guard';
import { catalogImportRun } from '@api/lib/inngest/functions/catalog-import-run';
import { catalogImportCreateDrafts } from '@api/lib/inngest/functions/catalog-import-create-drafts';
import { ciHintCalibrationWeekly } from '@api/lib/inngest/functions/ci-aggregation';
import {
  createDraftForItem,
  finishCreateDrafts,
  getJob,
  listJobs,
  publishItems,
} from '@api/services/catalog-import.service';
import { pageAllowance } from '@api/lib/catalogue/page-ledger';
void pageAllowance;
import { applyStoreGates, resolveAndSummarise } from '@api/services/ci-calibration.service';
import { ciOverview, orderCodRisk } from '@api/services/ci-hints.service';
import { storeGateClosed, storeGates } from '@api/lib/ci/hints/gates';

type Def = { handler: (ctx: unknown) => Promise<unknown> };
const step = { run: async (_n: string, fn: () => unknown) => fn(), sleep: async () => undefined };
const doDb = () => h.doBox.current;

beforeEach(() => {
  vi.clearAllMocks();
  h.doBox.current = new FakeStoreDo();
  vi.stubEnv('JOBS_ON_DO', '1');
  vi.stubEnv('STORE_DO_ENABLED_IDS', DO_STORE);
});

describe('the guard serves a DO store for the five flows of Ruling INTEG-1', () => {
  const IDS = [
    'catalog-import-run',
    'catalog-import-create-drafts',
    'catalog-import-uploads-sweep',
    'ci-hint-calibration-weekly',
  ];
  it('classifies each job (none or ported) and does not refuse a DO store', async () => {
    expect(jobDataClass('catalog-import-uploads-sweep')).toBe('none');
    for (const id of IDS.filter(i => i !== 'catalog-import-uploads-sweep'))
      expect(jobDataClass(id), id).toBe('ported');
    expect(ALL_STORES_JOBS.has('ci-hint-calibration-weekly')).toBe(true);
    for (const id of IDS) expect(MONEY_JOBS.has(id)).toBe(false);
    for (const id of IDS)
      expect(
        (await decideRunForStore(id, DO_STORE, { alarm: false } as never)).action,
        id
      ).not.toBe('refuse');
  });
});

const item = (over: Record<string, unknown> = {}) => ({
  id: 'item-1',
  storeId: DO_STORE,
  jobId: 'job-1',
  status: 'accepted',
  productId: null,
  name: 'Shirt',
  nameAr: null,
  description: null,
  descriptionAr: null,
  priceMinor: 1000,
  compareAtMinor: null,
  sku: 'SH-1',
  categoryId: null,
  categoryName: 'Tops',
  acknowledged: ['create_category'],
  flags: [],
  variants: [
    { options: { Size: 'S' }, priceMinor: 1000, sku: 'SH-1-S' },
    { options: { Size: 'M' }, priceMinor: 1000, sku: 'SH-1-M' },
  ],
  ...over,
});

describe('catalogue import on the DO (#329)', () => {
  it('createDraftForItem creates the category and the draft through the DO and the variants through importBatch; a second delivery is a no-op', async () => {
    doDb().seed('catalogImportJob', { id: 'job-1', storeId: DO_STORE, status: 'creating' });
    doDb().seed('catalogImportItem', item());

    expect(await createDraftForItem(DO_STORE, 'item-1')).toBe('created');
    expect(await createDraftForItem(DO_STORE, 'item-1')).toBe('skipped'); // double fire

    expect(h.productCreate).toHaveBeenCalledTimes(1);
    expect(h.money.importBatch).toHaveBeenCalledTimes(1);
    const call = (h.money.importBatch.mock.calls[0] as unknown[])[0] as {
      rows: Array<{ existingId: string; variants: unknown[] }>;
    };
    expect(call.rows[0].existingId).toBe('prod-1');
    expect(call.rows[0].variants).toHaveLength(2);
    expect(doDb().rows('category')).toHaveLength(1);
    expect(doDb().rows('catalogImportItem')[0]).toMatchObject({
      status: 'created',
      productId: 'prod-1',
    });
  });

  it('a failing variants batch removes the draft and fails the item (compensation), nothing reaches Postgres', async () => {
    h.money.importBatch.mockRejectedValueOnce(new Error('boom'));
    doDb().seed('catalogImportItem', item());
    doDb().seed('product', { id: 'prod-1', storeId: DO_STORE, status: 'draft' });
    expect(await createDraftForItem(DO_STORE, 'item-1')).toBe('failed');
    expect(doDb().rows('product')).toHaveLength(0);
    expect(doDb().rows('catalogImportItem')[0]).toMatchObject({
      status: 'failed',
      createErrorCode: 'VARIANTS_FAILED',
    });
  });

  it('finishCreateDrafts settles the job once, however many times it is delivered', async () => {
    doDb().seed('catalogImportJob', { id: 'job-1', storeId: DO_STORE, status: 'creating' });
    doDb().seed('catalogImportItem', item({ status: 'created', productId: 'prod-1' }));
    await finishCreateDrafts(DO_STORE, 'job-1');
    await finishCreateDrafts(DO_STORE, 'job-1');
    expect(doDb().rows('catalogImportJob')[0]).toMatchObject({ status: 'done', draftsCreated: 1 });
  });

  it('the create-drafts job lists the accepted items from the DO and creates each draft once on a replay', async () => {
    doDb().seed('catalogImportJob', { id: 'job-1', storeId: DO_STORE, status: 'creating' });
    doDb().seed('catalogImportItem', item({ variants: [] }));
    const ev = { data: { jobId: 'job-1', storeId: DO_STORE } };
    const run = () => (catalogImportCreateDrafts as unknown as Def).handler({ event: ev, step });
    expect(await run()).toEqual({ created: 1, failed: 0, skipped: 0 });
    expect(await run()).toEqual({ created: 0, failed: 0, skipped: 0 });
    expect(h.productCreate).toHaveBeenCalledTimes(1);
    expect(doDb().rows('catalogImportJob')[0]).toMatchObject({ status: 'done' });
  });

  it('the run job reads its files from the DO, extracts each once and finishes in review; a replay processes nothing twice', async () => {
    doDb().seed('catalogImportJob', { id: 'job-1', storeId: DO_STORE, status: 'queued' });
    doDb().seed('catalogImportFile', {
      id: 'file-1',
      storeId: DO_STORE,
      jobId: 'job-1',
      status: 'stored',
      createdAt: new Date(),
    });
    h.processFile.mockImplementation(async (storeId: string, _j: string, fileId: string) => {
      await h.doBox.current.writer.catalogImportFile.updateMany({
        where: { id: fileId, storeId },
        data: { status: 'done' },
      });
      return { outcome: 'done', calledModel: false };
    });
    const ev = { data: { jobId: 'job-1', storeId: DO_STORE } };
    const run = () => (catalogImportRun as unknown as Def).handler({ event: ev, step });
    await run();
    await run();
    expect(h.processFile).toHaveBeenCalledTimes(1);
    expect(doDb().rows('catalogImportJob')[0]).toMatchObject({ status: 'review' });
  });

  it('the request path reads jobs, the page ledger and publishes through the DO', async () => {
    doDb().seed('catalogImportJob', {
      id: 'job-1',
      storeId: DO_STORE,
      status: 'review',
      createdAt: new Date(),
    });
    doDb().seed(
      'catalogImportItem',
      item({ status: 'created', productId: 'prod-1', flags: [], acknowledged: [] })
    );
    doDb().seed('catalogImportFile', {
      id: 'f1',
      storeId: DO_STORE,
      jobId: 'job-1',
      chargedPages: 2,
      startedAt: new Date(),
    });
    doDb().seed('product', {
      id: 'prod-1',
      storeId: DO_STORE,
      status: 'draft',
      price: 1000,
      name: 'Shirt',
      deletedAt: null,
      hasVariants: false,
      variants: [],
      images: [{ id: 'i' }],
    });
    expect(JSON.stringify(await listJobs(DO_STORE))).toContain('job-1');
    expect((await getJob(DO_STORE, 'job-1')) as unknown).toBeTruthy();
    const out = await publishItems(DO_STORE, 'job-1', ['item-1']);
    expect(out.published).toBe(1);
    expect(h.bulkStatus).toHaveBeenCalledWith(DO_STORE, ['prod-1'], 'active');
    expect(doDb().reads).toContain('catalogImportJob.findMany');
  });
});

describe('Customer Intelligence hints on the DO (#336)', () => {
  const now = new Date('2026-10-30T10:00:00Z');

  it('resolveAndSummarise stamps the open hints from the DO shipments and a second delivery changes nothing', async () => {
    doDb().seed(
      'ciHintLog',
      {
        id: 'l1',
        storeId: DO_STORE,
        orderId: 'o1',
        outcome: null,
        createdAt: new Date(now.getTime() - 86_400_000),
        feature: 'cod_risk',
        band: 'high',
        predictedRate: 0.4,
      },
      {
        id: 'l2',
        storeId: DO_STORE,
        orderId: 'o2',
        outcome: null,
        createdAt: new Date(now.getTime() - 86_400_000),
        feature: 'cod_risk',
        band: 'high',
        predictedRate: 0.4,
      }
    );
    doDb().seed(
      'shipment',
      { storeId: DO_STORE, orderId: 'o1', returnedAt: new Date(), deliveredAt: null },
      { storeId: DO_STORE, orderId: 'o2', returnedAt: null, deliveredAt: new Date() }
    );
    const first = await resolveAndSummarise(DO_STORE, now);
    const snapshot = JSON.stringify(doDb().rows('ciHintLog'));
    const second = await resolveAndSummarise(DO_STORE, now);
    expect(JSON.stringify(doDb().rows('ciHintLog'))).toBe(snapshot);
    expect(second).toEqual(first);
    expect(
      doDb()
        .rows('ciHintLog')
        .map(r => r.outcome)
    ).toEqual(['returned', 'delivered']);
    expect(first).toEqual([
      expect.objectContaining({ feature: 'cod_risk', band: 'high', resolved: 2, returned: 1 }),
    ]);
  });

  it('applyStoreGates closes a mis-calibrated feature with ONE gate row however often it runs, and reopens it when the numbers recover', async () => {
    const off = [
      {
        storeId: DO_STORE,
        feature: 'cod_risk',
        band: 'high',
        resolved: 40,
        returned: 30,
        predictedSum: 4,
      },
    ];
    const a = await applyStoreGates(DO_STORE, off);
    const b = await applyStoreGates(DO_STORE, off); // double fire
    expect(a.closed).toEqual(['cod_risk']);
    expect(b.closed).toEqual([]);
    expect(doDb().rows('ciStoreGate')).toHaveLength(1);
    expect(await storeGateClosed(DO_STORE, 'cod_risk')).toBe(true);
    expect(await storeGates(DO_STORE)).toHaveLength(1);

    const ok = [
      {
        storeId: DO_STORE,
        feature: 'cod_risk',
        band: 'high',
        resolved: 40,
        returned: 4,
        predictedSum: 4,
      },
    ];
    expect((await applyStoreGates(DO_STORE, ok)).reopened).toEqual(['cod_risk']);
    expect(doDb().rows('ciStoreGate')).toHaveLength(0);
  });

  it('the weekly calibration job lists the DO store itself, resolves and gates it, and runs twice to the same state', async () => {
    doDb().seed('ciHintLog', {
      id: 'l1',
      storeId: DO_STORE,
      orderId: 'o1',
      outcome: null,
      createdAt: new Date(Date.now() - 86_400_000),
      feature: 'cod_risk',
      band: 'high',
      predictedRate: 0.4,
    });
    doDb().seed('shipment', {
      storeId: DO_STORE,
      orderId: 'o1',
      returnedAt: null,
      deliveredAt: new Date(),
    });
    const run = () =>
      (ciHintCalibrationWeekly as unknown as Def).handler({ event: { name: 'cron', data: {} } });
    const r1 = await run();
    const snapshot = JSON.stringify(doDb().rows('ciHintLog'));
    const r2 = await run();
    expect(r2).toEqual(r1);
    expect(JSON.stringify(doDb().rows('ciHintLog'))).toBe(snapshot);
    expect(doDb().rows('ciHintLog')[0].outcome).toBe('delivered');
    expect(h.sendAlert).not.toHaveBeenCalled();
  });

  it('orderCodRisk logs the hint ONCE per order when delivered twice, reading the order through the DO', async () => {
    doDb().seed('order', {
      id: 'o1',
      storeId: DO_STORE,
      areaKey: 'cairo',
      buyerKey: 'b1',
      payments: [{ provider: 'cod' }],
    });
    const a = await orderCodRisk(DO_STORE, 'o1');
    const b = await orderCodRisk(DO_STORE, 'o1');
    expect(a).toMatchObject({ enabled: true, applicable: true });
    expect(b).toMatchObject({ enabled: true, applicable: true });
    expect(doDb().rows('ciHintLog')).toHaveLength(1);
  });

  it('ciOverview counts the shown hints from the DO', async () => {
    h.platformStore.findFirst.mockResolvedValue({ ciSharing: true });
    doDb().seed(
      'ciHintLog',
      {
        storeId: DO_STORE,
        orderId: 'o1',
        feature: 'cod_risk',
        band: 'high',
        createdAt: new Date(),
      },
      { storeId: DO_STORE, orderId: 'o2', feature: 'cod_risk', band: 'high', createdAt: new Date() }
    );
    const o = await ciOverview(DO_STORE);
    expect(o.shown30d).toEqual([{ feature: 'cod_risk', band: 'high', count: 2 }]);
  });
});

describe('static: the INTEG-1 sources never call a store-do model on prisma', () => {
  const FILES = [
    'apps/api/src/lib/catalogue/process-file.ts',
    'apps/api/src/lib/catalogue/page-ledger.ts',
    'apps/api/src/lib/inngest/functions/catalog-import-run.ts',
    'apps/api/src/lib/inngest/functions/catalog-import-create-drafts.ts',
    'apps/api/src/services/catalog-import.service.ts',
    'apps/api/src/services/ci-calibration.service.ts',
    'apps/api/src/services/ci-hints.service.ts',
    'apps/api/src/lib/ci/hints/gates.ts',
  ];
  it.each(FILES)('%s', f => {
    const src = readFileSync(new URL(`../../${f}`, import.meta.url), 'utf8');
    expect(src).not.toMatch(
      /\bprisma\.(catalogImport(Job|File|Item)|ciHintLog|ciStoreGate|category|product|shipment|order)\./
    );
  });
});

void postgresGuard;
