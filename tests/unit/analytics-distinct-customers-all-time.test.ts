/** The all-time distinct-customer count on a Postgres store sends NO date parameter (an extreme Date does not serialise as a query value). */
import { describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ values: [] as unknown[][] }));

vi.mock('@ebda/database', async () =>
  (await import('./helpers/database-mock')).databaseMock({
    prisma: {
      $queryRaw: async (_s: TemplateStringsArray, ...values: unknown[]) => {
        h.values.push(values);
        return [{ customerId: 'u1', email: null, phone: null, n: 2 }];
      },
    },
    extra: {
      currentStoreId: () => 's1',
      Prisma: { sql: (_s: TemplateStringsArray, ...v: unknown[]) => ({ v }), empty: { v: [] } },
    },
  })
);
vi.mock('@api/services/redis.service', () => ({
  redis: { getClient: () => null, isAvailable: () => false },
}));
vi.mock('@api/lib/repo-factory', () => ({
  storeMoney: async () => null,
  storeDb: vi.fn(),
  storeRepo: vi.fn(),
}));
vi.mock('@api/lib/customer-groups-store', async () => {
  const { CustomerGroups } = await import('@api/lib/customer-groups');
  return { loadCustomerGroups: async () => new CustomerGroups([]) };
});

import { AnalyticsService } from '@api/services/analytics.service';

const dates = (x: unknown): Date[] =>
  x instanceof Date
    ? [x]
    : Array.isArray(x)
      ? x.flatMap(dates)
      : x && typeof x === 'object'
        ? Object.values(x).flatMap(dates)
        : [];

describe('countDistinctCustomers on a Postgres store', () => {
  it('all-time: only the store id is a parameter, no Date', async () => {
    h.values = [];
    expect(await AnalyticsService.countDistinctCustomers('s1')).toBe(1);
    expect(dates(h.values)).toEqual([]);
  });

  it('windowed: the window is passed as the two dates', async () => {
    h.values = [];
    const a = new Date('2026-01-01T00:00:00Z');
    const b = new Date('2026-02-01T00:00:00Z');
    await AnalyticsService.countDistinctCustomers('s1', a, b);
    expect(dates(h.values)).toEqual([a, b]);
  });
});
