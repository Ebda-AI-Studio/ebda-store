/**
 * Ruling CF-JOBS-4: the first half (alphabetical) of the non-money jobs serve a store on its Durable Object. For every job:
 *  - the guard no longer refuses it for a DO store (decideRunForStore -> run);
 *  - it reaches its store only through the DO-aware clients: the Postgres `prisma` stand-in THROWS for any store-do model, so a
 *    run that finishes proves no store row was read or written there;
 *  - where it writes, a second delivery (an at-least-once queue, a workflow replay, an alarm re-fire) leaves the state of one
 *    delivery: one row, the same totals, no duplicate alert.
 * The SQL of the DO side is proved on the real DO schema in packages/repo/test/rpc-writes-jobs.test.ts and
 * do-job-ops-nonmoney.test.ts; the static scan at the end keeps the job sources off `prisma.<store-do model>`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { FakeStoreDo, postgresGuard } from './helpers/fake-store-do';

const DO_STORE = '09b5dbd1-1774-49b5-b781-e06d0ee7b0fe';

const h = vi.hoisted(() => ({
  platformStore: { findUnique: vi.fn(), findFirst: vi.fn(), findUniqueOrThrow: vi.fn() },
  gemini: vi.fn(),
  sendContact: vi.fn(async () => undefined),
  money: {
    accountTotals: vi.fn(),
    ciOrderStamp: vi.fn(),
  },
  sendAlert: vi.fn(async () => 'sent'),
  aiSuggest: vi.fn(),
  invalidate: vi.fn(async () => undefined),
  invalidateRec: vi.fn(async () => undefined),
  recalcFbt: vi.fn(async () => undefined),
  importProducts: vi.fn(),
  doBox: { current: undefined as unknown as import('./helpers/fake-store-do').FakeStoreDo },
}));

vi.mock('@ebda/database', async () => {
  const { postgresGuard: guard } = await import('./helpers/fake-store-do');
  const prisma = guard({
    store: h.platformStore,
    aiUsage: { aggregate: vi.fn(async () => ({ _sum: { tokens: 0 } })), create: vi.fn() },
    // analytics-tier tables are platform rows (model-split.json: target analytics), not the store's
    productDailyView: { aggregate: vi.fn(async () => ({ _sum: { views: 0 } })) },
    $queryRaw: async () => [{ now: new Date() }],
  });
  return (await import('./helpers/database-mock')).databaseMock({
    prisma,
    defaultStoreIds: [],
    extra: {
      currentStoreId: () => DO_STORE,
      currentTenantGucs: () => undefined,
      AnomalyScope: { store: 'store', category: 'category', product: 'product' },
      AnomalyMetric: {
        margin_drop: 'margin_drop',
        cost_spike: 'cost_spike',
        revenue_drop: 'revenue_drop',
        refund_spike: 'refund_spike',
      },
      AnomalySeverity: { warning: 'warning', p0: 'p0' },
      hasTenantContext: () => false,
      // platform rows (`stores`) are still read in a short Postgres scope; any store-do model inside it still hits the guard
      runInTenantContext: async (_id: string, fn: () => Promise<unknown>) => fn(),
      withStore: async (_id: string, fn: (tx: unknown) => unknown) =>
        fn({ store: h.platformStore }),
      withoutHiddenStores: <T>(fn: () => T) => fn(),
      withHiddenStores: <T>(_s: unknown, fn: () => T) => fn(),
      dropHiddenStores: <T>(x: T) => x,
      storeDirectory: async (filter?: (s: Record<string, unknown>) => boolean) =>
        [
          {
            id: DO_STORE,
            name: 'Demo',
            slug: 'demo',
            status: 'active',
            plan: 'professional',
            aiFeaturesEnabled: true,
            accountingEnabled: true,
          },
        ].filter(s => (filter ? filter(s) : true)),
      acrossStores: async () => {
        throw new Error('Postgres touched: acrossStores');
      },
    },
  });
});
vi.mock('@api/lib/repo-factory', () => ({
  storeRepo: async (storeId: string) => ({
    storeId,
    backend: 'do',
    db: h.doBox.current.db,
    money: h.money,
  }),
  storeDb: async () => h.doBox.current.db,
  storeWriter: async () => h.doBox.current.writer,
  storeMoney: async () => h.money,
  storeUpdate: vi.fn(async () => ({})),
  runInJobRepoScope: <T>(fn: () => T) => fn(),
}));
vi.mock('@api/lib/inngest/client', () => ({
  inngest: {
    send: vi.fn(async () => undefined),
    createFunction: (options: unknown, handler: unknown) => ({ options, handler }),
  },
}));
vi.mock('@api/services/alerts.service', () => ({ sendAlert: h.sendAlert }));
vi.mock('@api/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@api/lib/ai-quota', () => ({
  assertAiQuota: vi.fn(async () => undefined),
  isAiQuotaCapError: () => false,
}));
vi.mock('@api/lib/inngest/ai-retry', () => ({ callWithRetry: (fn: () => unknown) => fn() }));
vi.mock('@api/lib/public-cache', () => ({ invalidateStoreProductCaches: h.invalidate }));
vi.mock('@api/services/store.service', () => ({
  bustStoreCachesById: vi.fn(async () => undefined),
}));
vi.mock('@api/services/ai.service', () => ({
  AIService: new Proxy({}, { get: () => h.aiSuggest }),
}));
vi.mock('@api/config', () => ({ config: { googleAiKey: 'k', smtpFromEmail: 'noreply@ebda.app' } }));
vi.mock('@api/services/email.service', () => ({
  EmailService: { sendStoreContactMessage: h.sendContact },
}));
vi.mock('@api/services/recommendation.service', () => ({
  recommendationService: {
    invalidateProductCache: h.invalidateRec,
    recalculateFBT: h.recalcFbt,
    invalidateStoreCache: vi.fn(),
  },
}));
vi.mock('@api/services/bulk.service', () => ({
  BulkService: { importProducts: h.importProducts },
}));
vi.mock('@api/services/accounting/gemini-ai.service', () => ({ callGemini: h.gemini }));
vi.mock('@api/lib/wa/config', () => ({
  suiteBuyerKeySecret: () => 'test-secret-test-secret-test-secret',
}));
vi.mock('@api/lib/leader-election', () => ({
  withLeaderLock: async (_n: string, _t: number, fn: () => Promise<unknown>) => fn(),
}));

import { MONEY_JOBS, NO_STORE_DATA_JOBS, PORTED_JOBS, jobDataClass } from '@api/lib/jobs/job-data';
import { decideRunForStore } from '@api/lib/jobs/do-guard';
import { JOBS_MAP } from '@api/lib/jobs/jobs-map';
import { ALARM_READY } from '@api/lib/jobs/alarm-flag';

/** The first half, alphabetical, of the 65 non-money jobs the guard refused (docs/cf/not-on-do.json before this ruling). */
const FIRST_HALF = [
  'account-erased-propagation',
  'accounting-expense-ocr-process',
  'accounting-profit-anomaly-cron',
  'agent-write-denied-watch',
  'ai-autofill-cleanup',
  'ai-autofill-product',
  'ai-autofill-sweep',
  'analytics-daily-rollup',
  'analytics-rollup-on-demand',
  'answer-engine-citation-scan-cron',
  'answer-engine-scan-on-demand',
  'bulk-ai-balance-descriptions',
  'bulk-ai-brand-facts',
  'bulk-ai-categorize',
  'bulk-ai-citation-copy',
  'bulk-ai-excerpt',
  'bulk-ai-faq-aeo',
  'bulk-ai-howto-aeo',
  'bulk-ai-image-alt',
  'bulk-ai-llms-txt',
  'bulk-ai-meta-aeo',
  'bulk-ai-product-faqs',
  'bulk-ai-recommendations',
  'bulk-ai-revert-balance',
  'bulk-ai-seo',
  'bulk-ai-tags',
  'bulk-ai-translate',
  'bulk-import-orphan-cleanup',
  'bulk-import-products',
  'ci-erasure-second-pass',
  'ci-outcomes',
  'contact-form-send',
  'domain-claim-sweep',
] as const;
/** Needs the accounting stack (expense, account, journal services) on the DO: written down as a blocker, still refused. */
// the expense-OCR job was blocked on the accounting stack here; Ruling CF-JOBS-4C ports it (tests/unit/jobs-blocked-expense-ocr-on-do.test.ts)
const BLOCKED: string[] = [];
const SERVED = FIRST_HALF.filter(id => !BLOCKED.includes(id));

beforeEach(() => {
  vi.clearAllMocks();
  h.doBox.current = new FakeStoreDo();
  vi.stubEnv('JOBS_ON_DO', '1');
  vi.stubEnv('STORE_DO_ENABLED_IDS', DO_STORE);
  h.platformStore.findUnique.mockResolvedValue(null);
  h.platformStore.findFirst.mockResolvedValue(null);
});

describe('the guard serves a DO store for every job of the first half', () => {
  it('names real jobs, none of them money jobs, and classifies each as none or ported', () => {
    expect(FIRST_HALF).toHaveLength(33);
    expect([...FIRST_HALF].sort()).toEqual([...FIRST_HALF]);
    for (const id of FIRST_HALF) {
      expect(JOBS_MAP[id], `${id} is not in JOBS_MAP`).toBeDefined();
      expect(MONEY_JOBS.has(id), `${id} is a money job`).toBe(false);
    }
    for (const id of SERVED) {
      expect(['none', 'ported'], id).toContain(jobDataClass(id));
      expect(NO_STORE_DATA_JOBS.has(id) || PORTED_JOBS.has(id), id).toBe(true);
    }
  });

  it('does not refuse any of them for a DO store (all served; none is blocked any more)', async () => {
    for (const id of SERVED)
      expect(await decideRunForStore({ id } as never, DO_STORE), id).toEqual({ run: true });
    for (const id of BLOCKED)
      expect(await decideRunForStore({ id } as never, DO_STORE), id).toMatchObject({ run: false });
  });

  it('a sweep that has a store alarm is alarm-ready (the DO store is served by its own alarm)', () => {
    for (const id of [
      'bulk-import-orphan-cleanup',
      'accounting-profit-anomaly-cron',
      'analytics-daily-rollup',
    ]) {
      expect(JOBS_MAP[id].alarm, id).toBe(true);
      expect(ALARM_READY.has(id), id).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// the bulk AI sweeps: the job row (BulkAiJob) and the catalogue reads follow the store's backend
// ---------------------------------------------------------------------------------------------------------------------
const step = {
  run: async <T>(_id: string, fn: () => Promise<T>): Promise<T> => {
    const v = await fn();
    return v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T);
  },
  sendEvent: vi.fn(async () => undefined),
};
type Def = { handler: (ctx: unknown) => Promise<unknown>; options: { id: string } };

describe('bulk AI sweeps run on the DO: the job row lives in the store, a second delivery changes nothing', () => {
  const sweeps: Array<[string, string, string]> = [
    ['bulk-ai-balance-descriptions', 'bulk-ai-balance-descriptions', 'bulkAiBalanceDescriptions'],
    ['bulk-ai-categorize', 'bulk-ai-categorize', 'bulkAiCategorize'],
    ['bulk-ai-excerpt', 'bulk-ai-excerpt', 'bulkAiExcerpt'],
    ['bulk-ai-image-alt', 'bulk-ai-image-alt', 'bulkAiImageAlt'],
    ['bulk-ai-product-faqs', 'bulk-ai-product-faqs', 'bulkAiProductFaqs'],
    ['bulk-ai-recommendations', 'bulk-ai-recommendations', 'bulkAiRecommendations'],
    ['bulk-ai-revert-balance', 'bulk-ai-revert-balance', 'bulkAiRevertBalance'],
    ['bulk-ai-seo', 'bulk-ai-seo', 'bulkAiSeo'],
    ['bulk-ai-tags', 'bulk-ai-tags', 'bulkAiTags'],
    ['bulk-ai-translate', 'bulk-ai-translate', 'bulkAiTranslate'],
    ['bulk-ai-faq-aeo', 'bulk-ai-aeo', 'bulkAiFaqAeo'],
    ['bulk-ai-howto-aeo', 'bulk-ai-aeo', 'bulkAiHowtoAeo'],
    ['bulk-ai-meta-aeo', 'bulk-ai-aeo', 'bulkAiMetaAeo'],
    ['bulk-ai-llms-txt', 'bulk-ai-geo', 'bulkAiLlmsTxt'],
    ['bulk-ai-citation-copy', 'bulk-ai-geo', 'bulkAiCitationCopy'],
    ['bulk-ai-brand-facts', 'bulk-ai-geo', 'bulkAiBrandFacts'],
  ];
  const NEEDS_REAL_AI = new Set([
    'bulk-ai-image-alt',
    'bulk-ai-product-faqs',
    'bulk-ai-recommendations',
    'bulk-ai-tags',
  ]);
  const TERMINAL = ['completed', 'failed', 'cancelled'];

  it.each(sweeps)('%s', async (id, file, exportName) => {
    const mod = (await import(`@api/lib/inngest/functions/${file}`)) as Record<string, Def>;
    const def = mod[exportName];
    expect(def.options.id).toBe(id);
    const run = () =>
      def.handler({
        event: {
          name: 'x',
          id: 'e1',
          data: { jobId: 'job-1', storeId: DO_STORE, direction: 'en_to_ar' },
        },
        step,
      });
    const doStore = h.doBox.current;
    doStore.seed('bulkAiJob', {
      id: 'job-1',
      storeId: DO_STORE,
      kind: id,
      status: 'queued',
      force: false,
    });
    // a catalogue of one product where the job's AI call is a plain stub; the rest run on an empty catalogue
    if (!NEEDS_REAL_AI.has(id))
      doStore.seed('product', {
        id: 'p1',
        storeId: DO_STORE,
        deletedAt: null,
        name: 'P',
        nameAr: 'ب',
        status: 'active',
      });

    await run(); // a throw here would be a Postgres touch: the guard prisma throws for every store-do model
    const once = structuredClone(doStore.rows('bulkAiJob'));
    expect(once).toHaveLength(1);
    expect(TERMINAL, `${id} left the job row at ${once[0].status}`).toContain(once[0].status);
    expect(doStore.writes.filter(w => w.startsWith('bulkAiJob.'))).not.toHaveLength(0);

    await run(); // the same event delivered again
    expect(doStore.rows('bulkAiJob')).toHaveLength(1);
    expect(doStore.rows('bulkAiJob')[0].status).toBe(once[0].status);
    expect(doStore.rows('bulkAiJob')[0].id).toBe('job-1');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// housekeeping and event jobs
// ---------------------------------------------------------------------------------------------------------------------
describe('housekeeping and event jobs on the DO', () => {
  it('ai-autofill-cleanup reads and deletes the recommendation graph in the DO; a second delivery deletes nothing more', async () => {
    const { aiAutofillCleanup } = await import('@api/lib/inngest/functions/ai-autofill-cleanup');
    const d = h.doBox.current;
    d.seed(
      'aiRecommendation',
      { id: 'r1', storeId: DO_STORE, sourceProductId: 'a', targetProductId: 'gone' },
      { id: 'r2', storeId: DO_STORE, sourceProductId: 'gone', targetProductId: 'b' },
      { id: 'r3', storeId: DO_STORE, sourceProductId: 'a', targetProductId: 'b' }
    );
    d.seed('frequentlyBoughtTogether', {
      id: 'f1',
      storeId: DO_STORE,
      productId1: 'a',
      productId2: 'gone',
    });
    d.seed('productRelation', {
      id: 'x1',
      storeId: DO_STORE,
      sourceProductId: 'a',
      targetProductId: 'gone',
    });
    const run = () =>
      (aiAutofillCleanup as unknown as Def).handler({
        event: { name: 'product.deleted', data: { storeId: DO_STORE, productId: 'gone' } },
      });
    await run();
    expect(d.rows('aiRecommendation').map(r => r.id)).toEqual(['r3']);
    expect(d.rows('frequentlyBoughtTogether')).toHaveLength(0);
    expect(d.rows('productRelation')).toHaveLength(0);
    expect(h.invalidateRec).toHaveBeenCalledWith(DO_STORE, 'a'); // the source whose list pointed at it
    const after = structuredClone([...d.tables]);
    await run();
    expect([...d.tables]).toEqual(after);
  });

  it("bulk-import-orphan-cleanup, on the DO store's alarm, marks a stuck import failed once and not again", async () => {
    const { bulkImportOrphanCleanup } =
      await import('@api/lib/inngest/functions/bulk-import-orphan-cleanup');
    const d = h.doBox.current;
    d.seed(
      'bulkImportJob',
      {
        id: 'old',
        storeId: DO_STORE,
        status: 'running',
        startedAt: new Date(Date.now() - 3 * 3600_000),
      },
      { id: 'fresh', storeId: DO_STORE, status: 'running', startedAt: new Date() }
    );
    const run = () =>
      (bulkImportOrphanCleanup as unknown as Def).handler({
        event: { name: 'cron', id: 'a1', data: { alarm: true, storeId: DO_STORE } },
      });
    expect(await run()).toEqual({ orphansSwept: 1 });
    expect(d.rows('bulkImportJob').map(r => [r.id, r.status])).toEqual([
      ['old', 'failed'],
      ['fresh', 'running'],
    ]);
    expect(await run()).toEqual({ orphansSwept: 0 });
  });

  it('bulk-import-products keeps its job row in the DO and imports ONCE when the event is delivered twice', async () => {
    const { bulkImportProducts } = await import('@api/lib/inngest/functions/bulk-import');
    const d = h.doBox.current;
    d.seed('bulkImportJob', {
      id: 'imp1',
      storeId: DO_STORE,
      status: 'queued',
      csvData: 'name\nX',
      updateExisting: false,
      userId: null,
    });
    h.importProducts.mockResolvedValue({ total: 1, created: 1, updated: 0, failed: 0, errors: [] });
    const run = () =>
      (bulkImportProducts as unknown as Def).handler({
        event: { name: 'bulk-import/started', data: { jobId: 'imp1', storeId: DO_STORE } },
      });
    await run();
    await run();
    expect(h.importProducts).toHaveBeenCalledTimes(1);
    expect(d.rows('bulkImportJob')).toHaveLength(1);
    expect(d.rows('bulkImportJob')[0]).toMatchObject({ status: 'completed', total: 1, created: 1 });
    expect(h.invalidate).toHaveBeenCalledTimes(1);
  });

  it('ci-outcomes reads the order through the DO, stamps it through the money op, and a re-delivery emits the same envelopes', async () => {
    const { emitCiOutcomesFor } = await import('@api/lib/inngest/functions/ci-outcomes');
    const d = h.doBox.current;
    d.seed('order', {
      id: 'o1',
      storeId: DO_STORE,
      total: 5000,
      currency: 'EGP',
      source: 'web',
      status: 'pending',
      paymentStatus: 'unpaid',
      createdAt: new Date('2026-10-01T10:00:00Z'),
      shippingAddress: { phone: '+201000000001', country: 'EG', city: 'Cairo' },
      _count: { items: 2 },
      payments: [],
      events: [],
      shipment: null,
      buyerKey: null,
      areaKey: null,
    });
    h.platformStore.findFirst.mockResolvedValue({ ciSharing: false });
    h.money.ciOrderStamp
      .mockResolvedValueOnce({ stamped: true })
      .mockResolvedValue({ stamped: false });
    const emitted: Array<Array<{ seed: string; type: string }>> = [];
    const port = { emit: vi.fn(async (x: never) => void emitted.push(x)) };
    const ev = { name: 'order/created', data: { storeId: DO_STORE, orderId: 'o1' } };
    expect(await emitCiOutcomesFor(ev, { port: port as never })).toBeGreaterThan(0);
    expect(await emitCiOutcomesFor(ev, { port: port as never })).toBeGreaterThan(0);
    expect(h.money.ciOrderStamp).toHaveBeenCalledTimes(2);
    expect(h.money.ciOrderStamp.mock.calls[0][0]).toMatchObject({ orderId: 'o1' });
    expect(emitted[1]).toEqual(emitted[0]); // deterministic ids: the second delivery collapses to the same rows
    expect(d.reads).toContain('order.findFirst');
  });

  it('the none-class jobs run for a DO store: contact mail, domain claims, third-party erasure', async () => {
    const { ciErasureSecondPass } =
      await import('@api/lib/inngest/functions/ci-erasure-second-pass');
    // no scope and no proven keys: nothing to erase, and it never touches the store
    expect(
      await ciErasureSecondPass(
        { data: { userId: 'u1' } },
        { sleep: async () => undefined, run: async (_i, fn) => fn() }
      )
    ).toEqual({ skipped: true });
    const { eraseCiOutcomes } =
      await import('@api/lib/inngest/functions/account-erased-propagation');
    expect(await eraseCiOutcomes('u1', undefined, undefined)).toEqual({ erased: 0 });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// watchers, scans and rollups
// ---------------------------------------------------------------------------------------------------------------------
describe('watchers, scans and rollups on the DO', () => {
  it('agent-write-denied-watch lists the DO store itself, reads its audit rows through the DO and pages once per class', async () => {
    const { agentWriteDeniedWatch } =
      await import('@api/lib/inngest/functions/agent-write-denied-watch');
    const { DENIAL_THRESHOLDS } = await import('@api/mcp/agent-denial-alerts');
    const d = h.doBox.current;
    for (let i = 0; i < DENIAL_THRESHOLDS.integrationBroken; i++)
      d.seed('auditLog', {
        id: `a${i}`,
        storeId: DO_STORE,
        action: 'agent.write.denied',
        ipAddress: '1.1.1.1',
        createdAt: new Date(),
        details: { credential: 'invalid', tool: 'place_order' },
      });
    d.seed('order', { id: 'o1', storeId: DO_STORE, source: 'agent' });
    const run = () =>
      (agentWriteDeniedWatch as unknown as Def).handler({ event: { name: 'cron', data: {} } });
    expect(await run()).toMatchObject({ ok: true, findings: 1 });
    expect(h.sendAlert).toHaveBeenCalledTimes(1);
    expect(h.sendAlert.mock.calls[0][0]).toMatchObject({
      store: { id: DO_STORE, name: 'Demo', slug: 'demo' }, // the name comes from the platform directory
    });
    expect(d.reads).toEqual(
      expect.arrayContaining(['auditLog.count', 'auditLog.findMany', 'order.findFirst'])
    );
    // a re-run reads the same rows and reaches the same verdict (it writes nothing)
    expect(await run()).toMatchObject({ ok: true, findings: 1 });
    expect(d.writes).toEqual([]);
  });

  it('accounting-profit-anomaly-cron: the ledger comes from the DO, the anomaly row is written there, the P0 pages once', async () => {
    const { runProfitAnomalyScan } =
      await import('@api/services/accounting/profit-anomaly.service');
    const d = h.doBox.current;
    const now = Date.now();
    h.money.accountTotals.mockImplementation(async (a: { fromMs?: number }) => ({
      rows: [
        {
          id: 'r',
          code: '4000',
          nameEn: 'Sales',
          nameAr: null,
          type: 'revenue',
          debit: 0,
          credit: a.fromMs !== undefined && a.fromMs > now - 8 * 86400_000 ? 0 : 1_800_000,
        },
      ],
    }));
    h.platformStore.findUniqueOrThrow.mockResolvedValue({
      id: DO_STORE,
      name: 'Demo',
      slug: 'demo',
    });
    h.gemini.mockResolvedValue({ explanationEn: 'e', explanationAr: 'a', likelyCause: 'demand' });
    const first = await runProfitAnomalyScan(DO_STORE);
    expect(first.detected).toBeGreaterThan(0);
    expect(d.rows('profitAnomaly').length).toBe(first.detected);
    expect(d.reads).toEqual(expect.arrayContaining(['payment.count', 'inventoryHistory.findMany']));
    expect(h.money.accountTotals).toHaveBeenCalled();
    const alerts = h.sendAlert.mock.calls.length;
    expect(alerts).toBe(1);
    // delivered twice: the 24 h dedupe sees the first P0 row and does not page again
    await runProfitAnomalyScan(DO_STORE);
    expect(h.sendAlert.mock.calls.length).toBe(alerts);
  });

  it('analytics rollup: snapshots are read and written in the DO, and a rerun updates the day instead of adding one', async () => {
    const { runStoreRollupSteps } =
      await import('@api/lib/inngest/functions/analytics-daily-rollup');
    const d = h.doBox.current;
    const r1 = await runStoreRollupSteps(step, DO_STORE, 'rollup');
    const funnelRows = d.rows('funnelSnapshot').length;
    expect(funnelRows).toBeGreaterThan(0);
    expect(r1.funnelDays).toBe(funnelRows);
    expect(d.writes).toEqual(expect.arrayContaining(['funnelSnapshot.createMany']));
    const r2 = await runStoreRollupSteps(step, DO_STORE, 'rollup');
    expect(d.rows('funnelSnapshot')).toHaveLength(funnelRows); // the same days, updated in place
    expect(r2.funnelDays).toBe(funnelRows);
    expect(d.writes).toEqual(expect.arrayContaining(['funnelSnapshot.update']));
  });

  it('answer-engine scan: checks are written to the DO, and a retried scan resumes past the rows it already wrote', async () => {
    const { runCitationScan } = await import('@api/services/answer-engine/citation-scan.service');
    const d = h.doBox.current;
    h.platformStore.findUnique.mockResolvedValue({ domain: 'demo.example', name: 'Demo' });
    const provider = {
      engine: 'gemini',
      query: vi.fn(async () => ({
        text: 'Demo is great',
        citedUrls: ['https://demo.example/'],
      })),
    };
    const runStartedAt = new Date(Date.now() - 1000);
    const prompts = [{ text: 'best demo', locale: 'en' as const }];
    const run = () =>
      runCitationScan(DO_STORE, { providers: [provider as never], prompts, runStartedAt });
    await run();
    const written = d.rows('answerEngineCheck').length;
    expect(written).toBe(1);
    await run(); // the retry: same run start, the pair is already answered
    expect(d.rows('answerEngineCheck')).toHaveLength(written);
    expect(provider.query).toHaveBeenCalledTimes(1); // and the paid call is not bought twice
  });

  it('ai-autofill: the guarded write goes to the DO as one procedure and stale fields are reported, never written', async () => {
    const { writeAiFieldsGuarded } = await import('@api/services/ai-autofill.service');
    const d = h.doBox.current;
    d.procResult = () => ({
      found: true,
      written: ['description'],
      stale: ['name'],
      categoryCount: 0,
    });
    const extra = vi.fn(async () => undefined);
    const out = await writeAiFieldsGuarded(
      '' + DO_STORE,
      'p1',
      { description: 'old', name: 'N' },
      { description: 'new', name: 'M' },
      { extra }
    );
    expect(out).toEqual({ written: ['description'], stale: ['name'] });
    expect(d.procs).toHaveLength(1);
    expect(d.procs[0]).toMatchObject({ name: 'guardedAiWrite', args: { productId: 'p1' } });
    expect(extra).toHaveBeenCalledWith({ categoryCount: 0 });
    expect(d.writes).toEqual([]); // no model write outside the procedure
  });

  it('ai-autofill-sweep lists the DO store itself and sweeps it through its DO, FBT recompute included', async () => {
    const { sweepAutofillStore } = await import('@api/lib/inngest/functions/ai-autofill-sweep');
    const d = h.doBox.current;
    h.platformStore.findUnique.mockResolvedValue({ theme: {}, aiFeaturesEnabled: true });
    const res = await sweepAutofillStore(DO_STORE);
    expect(res).toMatchObject({ products: 0 });
    expect(h.recalcFbt).toHaveBeenCalledWith(DO_STORE);
    expect(d.reads).toContain('product.findMany');
  });

  it('cron jobs that cover every store list the DO store even though the run hides it from storeDirectory', async () => {
    const { allStoresDirectory, acrossAllStoresDb } = await import('@api/lib/jobs/store-db');
    const seen: string[] = [];
    expect((await allStoresDirectory(undefined)).map(s => s.id)).toEqual([DO_STORE]);
    await acrossAllStoresDb(undefined, async (id, db) => {
      seen.push(id);
      expect(db).toBe(h.doBox.current.db); // the DO read client, not prisma
    });
    expect(seen).toEqual([DO_STORE]);
  });
});

describe('jobs that touch only platform rows run for a DO store', () => {
  it('contact-form-send mails the store its message: the address comes from the platform `stores` row', async () => {
    const { handleContactFormSubmitted } =
      await import('@api/lib/inngest/functions/contact-form-send');
    h.platformStore.findUnique.mockResolvedValue({
      email: 'shop@acme.example',
      isDemo: false,
      slug: 'acme',
      deletedAt: null,
      owner: null,
    });
    await handleContactFormSubmitted({
      event: {
        name: 'contact/form.submitted',
        data: { storeId: DO_STORE, name: 'A', email: 'a@b.example', subject: 's', message: 'm' },
      },
      step,
    });
    expect(h.sendContact).toHaveBeenCalledWith(
      DO_STORE,
      'shop@acme.example',
      expect.objectContaining({ subject: 's' })
    );
    expect(h.doBox.current.reads).toEqual([]); // not one store-do read
  });

  it('domain-claim-sweep lists claims through the platform directory, which a "none" job sees in full', async () => {
    const { DomainClaimService } = await import('@api/services/domain-claim.service');
    const provider = { addDomain: vi.fn(), removeDomain: vi.fn(), getStatus: vi.fn() };
    expect(await DomainClaimService.sweep(provider as never)).toEqual({
      examined: 0,
      activated: 0,
      failed: 0,
      released: 0,
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// the sources: no job (and no service it calls) reads or writes a store-do table through Postgres
// ---------------------------------------------------------------------------------------------------------------------
describe('the ported sources do not touch a store-do model through `prisma`', () => {
  const api = (p: string) => readFileSync(`apps/api/src/${p}`, 'utf8');
  const models: string[] = Object.entries(
    JSON.parse(readFileSync('packages/cf-schema/model-split.json', 'utf8')) as Record<
      string,
      { target: string }
    >
  )
    .filter(([, v]) => v.target === 'store-do')
    .map(([k]) => k[0].toLowerCase() + k.slice(1));
  const fns = [
    'accounting-profit-anomaly',
    'agent-write-denied-watch',
    'ai-autofill-cleanup',
    'ai-autofill-product',
    'ai-autofill-sweep',
    'analytics-daily-rollup',
    'answer-engine-citation-scan',
    'bulk-ai-aeo',
    'bulk-ai-balance-descriptions',
    'bulk-ai-categorize',
    'bulk-ai-excerpt',
    'bulk-ai-geo',
    'bulk-ai-image-alt',
    'bulk-ai-product-faqs',
    'bulk-ai-recommendations',
    'bulk-ai-revert-balance',
    'bulk-ai-seo',
    'bulk-ai-tags',
    'bulk-ai-translate',
    'bulk-import',
    'bulk-import-orphan-cleanup',
    'ci-outcomes',
  ].map(f => `lib/inngest/functions/${f}.ts`);
  const services = [
    'services/ai-autofill.service.ts',
    'services/recommendation.service.ts',
    'services/accounting/profit-anomaly.service.ts',
    'services/accounting/analytics-rollup.service.ts',
    'services/answer-engine/citation-scan.service.ts',
    'services/answer-engine/prompts.ts',
    'services/answer-engine/dashboard.service.ts',
    'lib/ci/source.ts',
  ];
  /** a Postgres-only branch reached only when `storeMoney()` is null: the job's own pg path, kept as it was */
  const PG_BRANCH: Record<string, number> = { 'lib/ci/source.ts': 1 };

  it.each([...fns, ...services])('%s', f => {
    const hits = [
      ...api(f).matchAll(new RegExp(`\\b(?:prisma|tx)\\.(${models.join('|')})\\.`, 'g')),
    ];
    expect(hits.map(m => m[0]).length, hits.map(m => m[0]).join(', ')).toBe(PG_BRANCH[f] ?? 0);
  });

  it('the one allowed Postgres write is the pg branch of the CI stamp, reached only without a money client', () => {
    const src = api('lib/ci/source.ts');
    expect(src.indexOf('money.ciOrderStamp')).toBeLessThan(src.indexOf('prisma.order.updateMany'));
    expect(src).toMatch(/if \(money\) \{[\s\S]*?return;/);
  });
});
