/**
 * Gold-rate pricing, Task 11 (Ruling B5-15): the 6-hourly feed cron's handler. An idle tick opens no
 * step; both feeds down writes nothing and raises ONE P1; disagreeing feeds store every opted-in
 * store's rate PENDING (never applied) and alert the operator; an ok quote is applied per store
 * through the service as the `feed` actor with the store's own premium.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  stores: [] as Array<{ storeId: string; premiumBps: number }>,
  applied: [] as Array<{
    storeId: string;
    rates: Array<{ karat: number; ratePerGram: number }>;
    actor: Record<string, unknown>;
  }>,
  pendingFor: new Set<string>(),
  alerts: [] as Array<{ level: string; source?: string; title: string }>,
  emails: [] as Array<{ kind: string; to: string }>,
  failApplyFor: new Set<string>(),
  failEmail: 0,
  sentinels: new Set<string>(),
}));
vi.mock('../../apps/api/src/services/redis.service', () => ({
  redis: {
    getClient: () => ({
      get: async (k: string) => (h.sentinels.has(k) ? '1' : null),
      set: async (k: string) => {
        h.sentinels.add(k);
        return 'OK';
      },
    }),
  },
}));
vi.mock('../../apps/api/src/lib/definer', () => ({
  goldFeedStores: async () => h.stores,
  goldRateWatch: async () => [],
}));
vi.mock('../../apps/api/src/services/gold-rate/gold-rate.service', () => ({
  GoldRateService: {
    applyRates: async (
      storeId: string,
      input: { rates: Array<{ karat: number; ratePerGram: number }> },
      actor: Record<string, unknown>
    ) => {
      h.applied.push({ storeId, rates: input.rates, actor });
      if (h.failApplyFor.has(storeId)) {
        const e = new Error('catalogue too large') as Error & { code: string };
        e.code = 'GOLD_CATALOGUE_TOO_LARGE';
        throw e;
      }
      const pending = h.pendingFor.has(storeId) || actor.forcePending === true;
      return pending
        ? {
            applied: [],
            pending: [
              { id: 'p1', karat: 21, ratePerGram: input.rates[1].ratePerGram, jumpBps: 700 },
            ],
            repriced: 0,
          }
        : {
            applied: input.rates.map(r => ({ id: 'x', karat: r.karat })),
            pending: [],
            repriced: 3,
          };
    },
  },
}));
vi.mock('../../apps/api/src/services/alerts.service', () => ({
  sendAlert: async (o: { level: string; source?: string; title: string }) => {
    h.alerts.push(o);
    return {};
  },
}));
vi.mock('../../apps/api/src/services/email.service', () => ({
  EmailService: {
    sendGoldRateNotice: async (_s: string, kind: string, d: { to: string }) => {
      if (h.failEmail > 0) {
        h.failEmail--;
        throw new Error('smtp down');
      }
      h.emails.push({ kind, to: d.to });
    },
  },
}));
vi.mock('../../apps/api/src/lib/jobs/store-db', async importOriginal => {
  const real = await importOriginal<Record<string, unknown>>();
  return {
    ...real,
    withStoreDb: async (_id: string, fn: (db: unknown) => unknown) =>
      fn({
        store: { findUnique: async () => ({ name: 'Dahab', owner: { email: 'o@example.com' } }) },
      }),
  };
});
vi.mock('@ebda/database', async importOriginal => {
  const real = await importOriginal<Record<string, unknown>>();
  return {
    ...real,
    runInStoreScope: async (_id: string, fn: () => unknown) => fn(),
    withStore: async (_id: string, fn: (tx: unknown) => unknown) =>
      fn({
        store: { findUnique: async () => ({ name: 'Dahab', owner: { email: 'o@example.com' } }) },
      }),
  };
});

const { handleGoldRateFeedFetch } =
  await import('../../apps/api/src/lib/inngest/functions/gold-rate-feed-fetch');
import type {
  GoldFeedQuote,
  GoldFeedResult,
} from '../../apps/api/src/services/gold-rate/feed/adapter';

let steps = 0;
const step = {
  run: async <T>(_id: string, fn: () => Promise<T>) => {
    steps++;
    return fn();
  },
};
const quote = (per24: number, source: 'primary' | 'fallback' = 'primary'): GoldFeedQuote => ({
  per24kGramPiastres: per24,
  fetchedAt: '2026-10-22T09:00:00.000Z',
  source,
  exact: { num: String(per24), den: '1' },
  reference: {
    xauUsdMicro: 4082300049,
    usdEgpMicro: 54385184,
    quotedAt: '2026-10-22T09:00:00.000Z',
  },
});
const adapter = (r: GoldFeedResult) => ({ fetch: async () => r });

beforeEach(() => {
  h.stores = [];
  h.applied.length = 0;
  h.pendingFor.clear();
  h.alerts.length = 0;
  h.emails.length = 0;
  h.failApplyFor.clear();
  h.failEmail = 0;
  h.sentinels.clear();
  steps = 0;
});

describe('gold-rate feed cron', () => {
  it('no store opted in: returns before opening any step (an empty tick costs one execution)', async () => {
    expect(await handleGoldRateFeedFetch({ step }, adapter({ kind: 'down' }))).toEqual({
      stores: 0,
    });
    expect(steps).toBe(0);
    expect(h.alerts).toEqual([]);
  });

  it('both feeds down: NO write, ONE P1, the last stored rate keeps serving', async () => {
    h.stores = [
      { storeId: 'a', premiumBps: 0 },
      { storeId: 'b', premiumBps: 0 },
    ];
    const r = await handleGoldRateFeedFetch({ step }, adapter({ kind: 'down' }));
    expect(r.outcome).toBe('down');
    expect(h.applied).toEqual([]);
    expect(h.alerts).toHaveLength(1);
    expect(h.alerts[0]).toMatchObject({ level: 'p1', source: 'cron.gold-rate-feed' });
  });

  it("an ok quote is applied to each store as the feed actor, with that store's own premium", async () => {
    h.stores = [
      { storeId: 'a', premiumBps: 0 },
      { storeId: 'b', premiumBps: 250 },
    ];
    const r = await handleGoldRateFeedFetch(
      { step },
      adapter({ kind: 'ok', quote: quote(713_800) })
    );
    expect(r).toMatchObject({ stores: 2, applied: 6, pending: 0, outcome: 'ok' });
    const a = h.applied.find(x => x.storeId === 'a')!;
    const b = h.applied.find(x => x.storeId === 'b')!;
    expect(a.rates.map(x => [x.karat, x.ratePerGram])).toEqual([
      [24, 713_800],
      [21, 624_575],
      [18, 535_350],
    ]);
    expect(b.rates[0].ratePerGram).toBe(731_645); // +250 bps, once
    expect(a.actor).toMatchObject({
      feed: expect.objectContaining({ source: 'primary' }),
      forcePending: false,
    });
    expect(h.alerts).toEqual([]);
  });

  it('feeds DISAGREE: every opted-in store gets a PENDING rate, nothing is applied, the operator gets a P1 and the owner an email', async () => {
    h.stores = [
      { storeId: 'a', premiumBps: 0 },
      { storeId: 'b', premiumBps: 0 },
    ];
    const r = await handleGoldRateFeedFetch(
      { step },
      adapter({
        kind: 'disagree',
        primary: quote(713_800),
        fallback: quote(731_000, 'fallback'),
        diffBps: 241,
      })
    );
    expect(r).toMatchObject({ outcome: 'disagree', applied: 0, pending: 2 });
    expect(h.applied.every(x => x.actor.forcePending === true)).toBe(true);
    expect(h.alerts.map(a => a.source)).toEqual(['cron.gold-rate-feed-disagree']);
    expect(h.emails).toEqual([
      { kind: 'pending', to: 'o@example.com' },
      { kind: 'pending', to: 'o@example.com' },
    ]);
  });

  it("a rate over a store's jump gate is stored pending and its owner is emailed, the other store applies", async () => {
    h.stores = [
      { storeId: 'a', premiumBps: 0 },
      { storeId: 'b', premiumBps: 0 },
    ];
    h.pendingFor.add('a');
    const r = await handleGoldRateFeedFetch(
      { step },
      adapter({ kind: 'ok', quote: quote(713_800) })
    );
    expect(r).toMatchObject({ applied: 3, pending: 1 });
    expect(h.emails).toEqual([{ kind: 'pending', to: 'o@example.com' }]);
  });

  // Ruling B5-36
  it("one store's apply error is a P1 for that store and the stores after it still get the rate", async () => {
    h.stores = [
      { storeId: 'a', premiumBps: 0 },
      { storeId: 'b', premiumBps: 0 },
      { storeId: 'c', premiumBps: 0 },
    ];
    h.failApplyFor.add('a');
    const r = await handleGoldRateFeedFetch(
      { step },
      adapter({ kind: 'ok', quote: quote(713_800) })
    );
    expect(r).toMatchObject({ applied: 6, failed: 1 });
    expect(h.applied.map(x => x.storeId)).toEqual(['a', 'b', 'c']);
    expect(h.alerts).toHaveLength(1);
    expect(h.alerts[0]).toMatchObject({ level: 'p1', source: 'cron.gold-rate-feed-store-failed' });
  });

  it('an email error after applyRates committed does not re-run applyRates, and is a P1', async () => {
    h.stores = [{ storeId: 'a', premiumBps: 0 }];
    h.pendingFor.add('a');
    h.failEmail = 1;
    const r = await handleGoldRateFeedFetch(
      { step },
      adapter({ kind: 'ok', quote: quote(713_800) })
    );
    expect(h.applied).toHaveLength(1); // applied exactly once
    expect(r).toMatchObject({ pending: 1, failed: 0 });
    expect(h.emails).toEqual([]);
    expect(h.alerts.map(a => a.source)).toEqual(['cron.gold-rate-feed-notice-failed']);
  });

  it('the pending email goes once per rate: a repeat for the same rate id is not sent again', async () => {
    h.stores = [{ storeId: 'a', premiumBps: 0 }];
    h.pendingFor.add('a');
    const q = adapter({ kind: 'ok', quote: quote(713_800) });
    await handleGoldRateFeedFetch({ step }, q);
    await handleGoldRateFeedFetch({ step }, q); // the mock returns the same pending rate id 'p1'
    expect(h.emails).toHaveLength(1);
  });
});
