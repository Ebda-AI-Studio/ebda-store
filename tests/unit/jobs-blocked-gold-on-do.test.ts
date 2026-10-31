/**
 * Ruling CF-JOBS-4B (INFRA-CF-1): the two gold-rate crons serve a store on its Durable Object. On the DO path the stores come from
 * the store's own tables on its alarm (Postgres and the definer functions THROW if reached), the rate is applied through the
 * service (money op), and a double fire sends the pending-rate mail once.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const DO_STORE = '09b5dbd1-1774-49b5-b781-e06d0ee7b0fe';
const h = vi.hoisted(() => ({
  settings: null as null | Record<string, unknown>,
  current: [] as Array<Record<string, unknown>>,
  sells: true,
  storeRow: { status: 'active', deletedAt: null } as Record<string, unknown> | null,
  sentinels: new Set<string>(),
  emails: [] as string[],
  applied: [] as string[],
}));
vi.mock('@api/lib/definer', () => ({
  goldFeedStores: async () => {
    throw new Error('Postgres touched: ebda_gold_feed_stores');
  },
  goldRateWatch: async () => {
    throw new Error('Postgres touched: ebda_gold_rate_watch');
  },
}));
vi.mock('@api/lib/repo-factory', () => ({
  storeRepo: async () => ({
    backend: 'do',
    db: {
      goldRateSettings: { findUnique: async () => h.settings },
      goldRateCurrent: { findMany: async () => h.current },
      product: { findFirst: async () => (h.sells ? { id: 'p' } : null) },
    },
  }),
}));
vi.mock('@ebda/database', async () =>
  (await import('./helpers/database-mock')).databaseMock({
    prisma: new Proxy(
      {},
      {
        get: (_t, p) => {
          throw new Error(`Postgres touched: prisma.${String(p)}`);
        },
      }
    ),
    extra: {
      withStore: async (_id: string, fn: (tx: unknown) => Promise<unknown>) =>
        fn({
          store: {
            findUnique: async (a: { select: Record<string, unknown> }) =>
              'owner' in a.select
                ? { name: 'Dahab', slug: 'dahab', owner: { email: 'o@example.com' } }
                : h.storeRow,
          },
        }),
      runInStoreScope: (_id: string, fn: () => unknown) => fn(),
    },
  })
);
vi.mock('@api/services/redis.service', () => ({
  redis: {
    getClient: () => ({
      get: async (k: string) => (h.sentinels.has(k) ? '1' : null),
      set: async (k: string) => (h.sentinels.add(k), 'OK'),
    }),
  },
}));
vi.mock('@api/services/email.service', () => ({
  EmailService: {
    sendGoldRateNotice: async (_s: string, kind: string) => void h.emails.push(kind),
  },
}));
vi.mock('@api/services/alerts.service', () => ({ sendAlert: vi.fn(async () => 'sent') }));
vi.mock('@api/services/gold-rate/gold-rate.service', () => ({
  GoldRateService: {
    applyRates: async (storeId: string) => {
      h.applied.push(storeId);
      return {
        applied: [],
        pending: [{ id: 'r1', karat: 21, ratePerGram: 410000, jumpBps: 700 }],
        repriced: 0,
      };
    },
  },
}));
vi.mock('@api/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { goldFeedStoresFor, goldRateWatchFor } from '@api/lib/jobs/gold-stores';
import { handleGoldRateFeedFetch } from '@api/lib/inngest/functions/gold-rate-feed-fetch';
import { handleGoldRateStalenessWatch } from '@api/lib/inngest/functions/gold-rate-staleness-watch';
import { PORTED_JOBS } from '@api/lib/jobs/job-data';
import { ALARM_READY } from '@api/lib/jobs/alarm-flag';
import { JOBS_MAP } from '@api/lib/jobs/jobs-map';

const alarm = { name: 'x', data: { alarm: true, storeId: DO_STORE } };
const step = {
  run: async <T>(_id: string, fn: () => Promise<T>): Promise<T> => {
    const v = await fn();
    return v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T);
  },
  cfWorkflow: true as const,
};
const quote = {
  per24kGramPiastres: 500000,
  fetchedAt: '2026-10-22T09:00:00.000Z',
  source: 'primary' as const,
  exact: { num: '500000', den: '1' },
  reference: {
    xauUsdMicro: 4082300049,
    usdEgpMicro: 54385184,
    quotedAt: '2026-10-22T09:00:00.000Z',
  },
};
const adapter = { fetch: async () => ({ kind: 'ok' as const, quote }) };

beforeEach(() => {
  h.settings = { enabled: true, feedEnabled: true, feedPremiumBps: 50, maxAgeMinutes: 1560 };
  h.current = [];
  h.sells = true;
  h.storeRow = { status: 'active', deletedAt: null };
  h.sentinels.clear();
  h.emails.length = 0;
  h.applied.length = 0;
});

describe('gold-rate jobs are ported and alarm-armed', () => {
  it.each(['gold-rate-feed-fetch', 'gold-rate-staleness-watch'])('%s', id => {
    expect(PORTED_JOBS.has(id)).toBe(true);
    expect(ALARM_READY.has(id)).toBe(true);
    expect(JOBS_MAP[id].alarm).toBe(true);
  });
});

describe('gold-rate-feed-fetch on a DO store', () => {
  it('lists the opted-in store from its own settings, never the definer', async () => {
    expect(await goldFeedStoresFor(alarm)).toEqual([{ storeId: DO_STORE, premiumBps: 50 }]);
    h.settings = { enabled: true, feedEnabled: false, feedPremiumBps: 0 };
    expect(await goldFeedStoresFor(alarm)).toEqual([]);
    h.settings = null;
    expect(await goldFeedStoresFor(alarm)).toEqual([]);
  });

  it('a deleted store is not served', async () => {
    h.storeRow = { status: 'active', deletedAt: new Date() };
    expect(await goldFeedStoresFor(alarm)).toEqual([]);
  });

  it('double fire: applies each time, mails the pending rate once', async () => {
    const run = () => handleGoldRateFeedFetch({ step, event: alarm }, adapter);
    const first = (await run()) as { stores: number; pending: number };
    await run();
    expect(first).toMatchObject({ stores: 1, pending: 1 });
    expect(h.applied).toEqual([DO_STORE, DO_STORE]);
    expect(h.emails).toEqual(['pending']);
  });
});

describe('gold-rate-staleness-watch on a DO store', () => {
  const now = new Date('2026-10-30T12:00:00Z');
  const old = (hours: number) => new Date(now.getTime() - hours * 3_600_000);

  it('returns nothing while the rate is fresh, the row once inside the warn window', async () => {
    h.current = [];
    expect(await goldRateWatchFor(alarm, now)).toEqual([]);
    h.current = [{ karat: 21, rateId: 'r1', appliedAt: old(23) }];
    const rows = await goldRateWatchFor(alarm, now);
    expect(rows).toEqual([
      { storeId: DO_STORE, karat: 21, rateId: 'r1', appliedAt: old(23), maxAgeMinutes: 1560 },
    ]);
  });

  it('ignores a karat the store does not sell', async () => {
    h.current = [{ karat: 18, rateId: 'r2', appliedAt: old(25) }];
    h.sells = false;
    expect(await goldRateWatchFor(alarm, now)).toEqual([]);
  });

  it('double fire: the stale warning goes out once', async () => {
    h.current = [{ karat: 21, rateId: 'r1', appliedAt: old(23) }];
    const run = () => handleGoldRateStalenessWatch({ step, event: alarm }, now);
    await run();
    await run();
    expect(h.emails).toEqual(['warning']);
  });
});
