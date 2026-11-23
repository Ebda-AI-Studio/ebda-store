/**
 * Sales chart bucketing (GET /analytics/sales → AnalyticsService.getSalesChart).
 *
 * Before (2026-09-30 audit, finding 1 backend side): the route cast `period` to
 * day|week|month|year, so every 9-preset value fell to the `default` branch and
 * was grouped BY DAY — `this_year` sent ~270 daily bars. And the zero-fill
 * walked UTC days from a start that is the browser's local midnight (21:00Z for
 * Egypt), adding a phantom leading bucket for the previous UTC day.
 *
 * Now the bucket is picked from the range length and buckets are the viewer's
 * calendar days (tzOffset). Every preset is checked (enum-as-checklist).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { queryRaw } = vi.hoisted(() => ({ queryRaw: vi.fn() }));

vi.mock('@ebda/database', () => ({
  prisma: { $queryRaw: queryRaw },
  Prisma: { sql: () => ({}), raw: (s: string) => ({ sql: s }) },
}));
vi.mock('../../apps/api/src/services/redis.service', () => ({ redis: {} }));
vi.mock('../../apps/api/src/services/accounting/reports.service', () => ({
  profitAndLoss: vi.fn(),
}));
vi.mock('../../apps/api/src/lib/effective-inventory-sql', () => ({ ON_HAND_SQL: {} }));

import {
  AnalyticsService,
  salesBucketKey,
  salesBucketStart,
} from '../../apps/api/src/services/analytics.service';
import {
  ANALYTICS_PERIOD_PRESETS,
  pickSalesGranularity,
} from '../../packages/shared/src/schemas/analytics';
import { resolveDateRange } from '../../apps/admin/src/app/stores/[id]/analytics/_components/types';

const STORE = 'store-1';
const TZ_OFFSET_MIN = 180; // minutes east of UTC

beforeEach(() => {
  queryRaw.mockReset();
  queryRaw.mockResolvedValue([]);
});

describe('pickSalesGranularity — every preset gets a readable number of bars', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-30T12:00:00Z'));
  });
  afterEach(() => vi.useRealTimers());

  const expected: Record<string, 'day' | 'week' | 'month'> = {
    today: 'day',
    yesterday: 'day',
    last_7: 'day',
    last_30: 'day',
    last_90: 'week',
    this_month: 'day',
    last_month: 'day',
    this_year: 'month',
    custom: 'day', // custom with no range falls back to this_month
  };

  for (const preset of ANALYTICS_PERIOD_PRESETS) {
    it(`${preset} → ${expected[preset]}`, () => {
      const { startDate, endDate } = resolveDateRange(preset);
      expect(pickSalesGranularity(startDate, endDate)).toBe(expected[preset]);
    });
  }
});

describe('bucket helpers', () => {
  it('weeks start on Monday (Postgres date_trunc week)', () => {
    // 2026-09-30 is a Wednesday.
    expect(salesBucketKey(new Date('2026-09-30T10:00:00Z'), 'week')).toBe('2026-09-28');
    expect(salesBucketKey(new Date('2026-09-28T00:00:00Z'), 'week')).toBe('2026-09-28');
    expect(salesBucketKey(new Date('2026-09-27T23:59:59Z'), 'week')).toBe('2026-09-21');
  });

  it('month keys are YYYY-MM', () => {
    expect(salesBucketKey(new Date('2026-02-17T00:00:00Z'), 'month')).toBe('2026-02');
    expect(salesBucketStart(new Date('2026-02-17T05:00:00Z'), 'month').toISOString()).toBe(
      '2026-02-01T00:00:00.000Z'
    );
  });
});

describe('AnalyticsService.getSalesChart', () => {
  it('this_year → monthly buckets (not ~270 daily bars)', async () => {
    // Egypt midnight Jan 1 → end of Sep 30, Egypt.
    const startDate = new Date('2025-12-31T21:00:00Z');
    const endDate = new Date('2026-09-30T20:59:59Z');
    queryRaw.mockResolvedValue([
      { period: new Date('2026-09-01T00:00:00Z'), revenue: 84_000, orders: 84n },
    ]);

    const { sales, granularity } = await AnalyticsService.getSalesChart(
      STORE,
      'this_year',
      { startDate, endDate },
      TZ_OFFSET_MIN
    );

    expect(granularity).toBe('month');
    expect(sales.map(s => s.date)).toEqual([
      '2026-01',
      '2026-02',
      '2026-03',
      '2026-04',
      '2026-05',
      '2026-06',
      '2026-07',
      '2026-08',
      '2026-09',
    ]);
    expect(sales[8]).toEqual({ date: '2026-09', revenue: 84_000, orders: 84 });
    // The SQL buckets by the same unit.
    expect(queryRaw.mock.calls[0]).toContain('month');
  });

  it('local-midnight start in Egypt → no phantom leading bucket for the previous UTC day', async () => {
    const startDate = new Date('2026-08-31T21:00:00Z'); // Sep 1 00:00 Egypt
    const endDate = new Date('2026-09-30T20:59:59Z'); // Sep 30 23:59 Egypt
    const { sales, granularity } = await AnalyticsService.getSalesChart(
      STORE,
      'this_month',
      { startDate, endDate },
      TZ_OFFSET_MIN
    );
    expect(granularity).toBe('day');
    expect(sales[0].date).toBe('2026-09-01');
    expect(sales[sales.length - 1].date).toBe('2026-09-30');
    expect(sales).toHaveLength(30);
    // The offset reaches the SQL so the DB buckets on the same calendar days.
    expect(queryRaw.mock.calls[0]).toContain(TZ_OFFSET_MIN);
  });

  it('last_90 → weekly buckets keyed on Mondays', async () => {
    const endDate = new Date('2026-09-30T20:59:59Z');
    const startDate = new Date('2026-07-02T21:00:00Z');
    const { sales, granularity } = await AnalyticsService.getSalesChart(
      STORE,
      'last_90',
      { startDate, endDate },
      TZ_OFFSET_MIN
    );
    expect(granularity).toBe('week');
    expect(sales.length).toBeGreaterThanOrEqual(13);
    expect(sales.length).toBeLessThanOrEqual(14);
    for (const s of sales) expect(new Date(`${s.date}T00:00:00Z`).getUTCDay()).toBe(1);
  });
});
