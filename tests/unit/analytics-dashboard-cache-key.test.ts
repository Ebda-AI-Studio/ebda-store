/**
 * Issues 2247 / 2269 — the dashboard's customer counts must not re-scan the
 * store's orders on every request.
 *
 *  - With no date range the window ended at a raw `new Date()`, so the cache
 *    key was unique per millisecond and the 120s cache never hit.
 *  - The all-time distinct-customer count (a full scan: its DISTINCT key is a
 *    computed expression no index can serve) rode that range-keyed cache, so
 *    it re-ran for every range too.
 *
 * Mutation proof: in analytics.service.ts use `now` instead of
 * `endOfMinute(now)` → the first case goes red; call
 * `this.countDistinctCustomers(storeId)` directly instead of
 * `this.getAllTimeCustomers(storeId)` → the second goes red.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@ebda/database', () => ({ prisma: {}, Prisma: { sql: () => ({}), empty: {} } }));
vi.mock('@api/services/redis.service', () => ({
  redis: { get: vi.fn(async () => null), set: vi.fn(async () => undefined) },
}));
vi.mock('@api/services/accounting/reports.service', () => ({ profitAndLoss: vi.fn() }));
// The dashboard payload rides the generation-guarded public cache (STORE-QA-74: revenue is invalidated on every refund). Its
// generation protocol is proven in the public-cache tests; here only the KEY is under test, so the cache is a keyed Map.
vi.mock('@api/lib/public-cache', () => {
  const m = new Map<string, unknown>();
  return {
    getCached: async (key: string, _ttl: number, fn: () => Promise<unknown>) => {
      if (m.has(key)) return m.get(key);
      const v = await fn();
      m.set(key, v);
      return v;
    },
    invalidateCachedPrefix: vi.fn(),
    invalidateCustomersCache: vi.fn(),
  };
});

import { AnalyticsService, endOfMinute } from '@api/services/analytics.service';

const STATS = {
  revenue: 0,
  orders: 0,
  customers: 0,
  profit: 0,
  itemsMissingCost: 0,
  revenueMissingCost: 0,
};

let storeSeq = 0;
let storeId = '';

beforeEach(() => {
  vi.restoreAllMocks();
  storeId = `store-${++storeSeq}`;
});
afterEach(() => vi.useRealTimers());

describe('dashboard stats cache', () => {
  it('two default-range requests in the same minute compute once', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-30T10:15:03.120Z'));
    const compute = vi
      .spyOn(AnalyticsService as any, '_computeDashboardStats')
      .mockResolvedValue({ totalCustomers: 1 });

    await AnalyticsService.getDashboardStats(storeId);
    vi.setSystemTime(new Date('2026-09-30T10:15:41.777Z'));
    await AnalyticsService.getDashboardStats(storeId);

    expect(compute).toHaveBeenCalledTimes(1);
    // The window still reaches "now" — it ends at the minute's last ms.
    expect((compute.mock.calls[0][2] as Date).toISOString()).toBe('2026-09-30T10:15:59.999Z');
  });

  it('the all-time customer count is shared across date ranges', async () => {
    vi.spyOn(AnalyticsService as any, 'getPeriodStats').mockResolvedValue(STATS);
    vi.spyOn(AnalyticsService, 'getViewsConversionRate').mockResolvedValue(null);
    const { prisma } = await import('@ebda/database');
    (prisma as any).product = { count: vi.fn(async () => 0) };
    const allTime = vi.spyOn(AnalyticsService, 'countDistinctCustomers').mockResolvedValue(7);

    const a = await AnalyticsService.getDashboardStats(storeId, {
      startDate: new Date('2026-09-01T00:00:00Z'),
      endDate: new Date('2026-09-30T00:00:00Z'),
    });
    const b = await AnalyticsService.getDashboardStats(storeId, {
      startDate: new Date('2026-07-01T00:00:00Z'),
      endDate: new Date('2026-09-30T00:00:00Z'),
    });

    expect(a.allTimeCustomers).toBe(7);
    expect(b.allTimeCustomers).toBe(7);
    // Only the unbounded (all-time) call — getPeriodStats is stubbed.
    expect(allTime).toHaveBeenCalledTimes(1);
    expect(allTime).toHaveBeenCalledWith(storeId);
  });

  it('endOfMinute keeps the minute and ends at its last millisecond', () => {
    expect(endOfMinute(new Date('2026-09-30T23:59:00.000Z')).toISOString()).toBe(
      '2026-09-30T23:59:59.999Z'
    );
  });
});
