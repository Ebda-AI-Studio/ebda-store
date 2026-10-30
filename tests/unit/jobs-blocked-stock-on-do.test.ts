/**
 * Ruling CF-JOBS-4B: the four stock scan jobs (dead stock, low stock; cron and on-demand) for a store on its Durable Object.
 * The catalogue comes from the DO read client, the last paid sale from the DO op `lastPaidSales`, the flags are written through
 * the DO writer, and Postgres THROWS if reached (the `Store` row is the platform mock). Double fire: one open flag per product,
 * one digest per product (the Redis sentinel claim).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const DO_STORE = '09b5dbd1-1774-49b5-b781-e06d0ee7b0fe';
const DAY = 86_400_000;
const h = vi.hoisted(() => ({
  flags: [] as Array<Record<string, any>>,
  products: [] as Array<Record<string, any>>,
  lastSales: {} as Record<string, number>,
  sentinels: new Set<string>(),
  emails: [] as string[],
  boom: (what: string): object =>
    new Proxy(
      {},
      {
        get: (_t, p) => {
          throw new Error(`Postgres touched: ${what}.${String(p)}`);
        },
      }
    ),
}));
vi.mock('@ebda/database', async () =>
  (await import('./helpers/database-mock')).databaseMock({
    prisma: h.boom('prisma'),
    extra: {
      Prisma: { join: () => ({}) },
      storeDirectory: async (pred: (s: any) => boolean) =>
        [{ id: DO_STORE, accountingEnabled: true, aiFeaturesEnabled: true, plan: 'growth' }].filter(
          pred
        ),
      withStore: async (_id: string, fn: (tx: unknown) => Promise<unknown>) =>
        fn({
          store: {
            findUnique: async (a: { select: Record<string, unknown> }) =>
              'owner' in a.select
                ? { id: DO_STORE, name: 'Dahab', settings: {}, owner: { email: 'o@example.com' } }
                : { plan: 'growth', name: 'Dahab' },
          },
        }),
    },
  })
);
vi.mock('@api/lib/repo-factory', () => {
  const db = {
    product: { findMany: async () => h.products },
  };
  const writer = {
    deadStockFlag: {
      updateMany: async () => ({ count: 0 }),
      findFirst: async (a: { where: Record<string, any> }) =>
        h.flags.find(f => f.productId === a.where.productId && f.status === 'open') ?? null,
      update: async (a: { where: { id: string }; data: Record<string, any> }) =>
        Object.assign(h.flags.find(f => f.id === a.where.id)!, a.data),
      create: async (a: { data: Record<string, any> }) => (
        h.flags.push({ id: `f${h.flags.length + 1}`, ...a.data }),
        a.data
      ),
    },
  };
  const money = {
    lastPaidSales: async () => ({ sales: h.lastSales }),
  };
  const repo = { backend: 'do', db, writer, money };
  return {
    storeRepo: async () => repo,
    storeDb: async () => db,
    storeWriter: async () => writer,
    storeMoney: async () => money,
  };
});
vi.mock('@api/services/accounting/gemini-ai.service', () => ({
  callGemini: async () => ({
    items: [{ productId: 'p1', discountPercent: 30, copyEn: 'Clear', copyAr: 'تخفيض' }],
  }),
}));
vi.mock('@api/services/redis.service', () => ({
  redis: {
    getClient: () => ({
      set: async (k: string) => (h.sentinels.has(k) ? null : (h.sentinels.add(k), 'OK')),
      get: async (k: string) => (h.sentinels.has(k) ? '1' : null),
      del: async (k: string) => (h.sentinels.delete(k), 1),
      pipeline: () => {
        const ops: Array<() => unknown> = [];
        const p: any = {
          exists: (k: string) => (ops.push(() => [null, h.sentinels.has(k) ? 1 : 0]), p),
          get: (k: string) => (ops.push(() => [null, h.sentinels.has(k) ? '1' : null]), p),
          del: (k: string) => (ops.push(() => (h.sentinels.delete(k), [null, 1])), p),
          set: (k: string) => (ops.push(() => (h.sentinels.add(k), [null, 'OK'])), p),
          exec: async () => ops.map(o => o()),
        };
        return p;
      },
    }),
  },
}));
vi.mock('@api/lib/inngest/client', () => ({
  inngest: { createFunction: (options: unknown, handler: unknown) => ({ options, handler }) },
}));
vi.mock('@api/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@api/services/feature.service', () => ({
  featureService: { isFeatureEnabled: async () => true },
}));
vi.mock('@api/services/email.service', () => ({
  EmailService: {
    sendLowStockAlert: async (_s: string, d: { to: string }) => void h.emails.push(d.to),
  },
}));

import {
  stockDeadstockScanCron,
  stockDeadstockScanOnDemand,
} from '@api/lib/inngest/functions/stock-deadstock-scan';
import {
  stockLowStockAlertCron,
  stockLowStockAlertOnDemand,
} from '@api/lib/inngest/functions/stock-low-stock-alert';
import { PORTED_JOBS } from '@api/lib/jobs/job-data';
import { decideRunForStore } from '@api/lib/jobs/do-guard';

type Handler = { handler: (a: unknown) => Promise<any> };
const step = {
  run: async <T>(_id: string, fn: () => Promise<T>): Promise<T> => {
    const v = await fn();
    return v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T);
  },
  sendEvent: async () => undefined,
};
const alarm = { name: 'x', data: { alarm: true, storeId: DO_STORE } };
const call = (job: unknown, event: object) => (job as Handler).handler({ event, step });

beforeEach(() => {
  h.flags.length = 0;
  h.emails.length = 0;
  h.sentinels.clear();
  h.lastSales = {};
  h.products = [
    {
      id: 'p1',
      name: 'Lamp',
      nameAr: 'لمبة',
      inventory: 3,
      costPrice: 300_000,
      lowStockThreshold: 5,
      createdAt: new Date(Date.now() - 400 * DAY),
      variants: [],
    },
  ];
  vi.stubEnv('JOBS_ON_DO', '1');
  vi.stubEnv('STORE_DO_ENABLED_IDS', DO_STORE);
  vi.stubEnv('AI_BULK_THROTTLE_MS', '0');
});

describe('the four stock jobs are ported', () => {
  it.each([
    'stock-deadstock-scan-cron',
    'stock-deadstock-scan-on-demand',
    'stock-low-stock-alert-cron',
    'stock-low-stock-alert-on-demand',
  ])('%s', id => {
    expect(PORTED_JOBS.has(id)).toBe(true);
    expect(decideRunForStore({ id } as never, DO_STORE)).toEqual({ run: true });
  });
});

describe('dead-stock scan on a DO store', () => {
  it('flags a stale product through the DO writer; double fire keeps ONE open flag', async () => {
    const first = await call(stockDeadstockScanCron, alarm);
    expect(first).toMatchObject({ stores: 1, totalFlagged: 1 });
    await call(stockDeadstockScanCron, alarm);
    expect(h.flags).toHaveLength(1);
    expect(h.flags[0]).toMatchObject({
      productId: 'p1',
      status: 'open',
      suggestedDiscountBps: 3000,
    });
  });

  it('a product sold recently is not flagged (last sale from the DO op)', async () => {
    h.lastSales = { p1: Date.now() - 5 * DAY };
    await call(stockDeadstockScanCron, alarm);
    expect(h.flags).toHaveLength(0);
  });

  it('on-demand runs the same scan', async () => {
    const out = await call(stockDeadstockScanOnDemand, {
      name: 'stock/deadstock-scan-requested',
      data: { storeId: DO_STORE },
    });
    expect(out).toMatchObject({ flagged: 1 });
    expect(h.flags).toHaveLength(1);
  });
});

describe('low-stock alert on a DO store', () => {
  it('mails the digest once; the double fire is claimed by the sentinel', async () => {
    const first = await call(stockLowStockAlertCron, alarm);
    await call(stockLowStockAlertCron, alarm);
    expect(first).toMatchObject({ stores: 1, totalAlerted: 1, emailsSent: 1 });
    expect(h.emails).toEqual(['o@example.com']);
  });

  it('on-demand scans the DO catalogue', async () => {
    const out = await call(stockLowStockAlertOnDemand, {
      name: 'stock/low-stock-scan-requested',
      data: { storeId: DO_STORE },
    });
    expect(out).toMatchObject({ alerted: 1, emailed: true });
  });
});
