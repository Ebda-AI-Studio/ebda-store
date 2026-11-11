import { describe, it, expect, vi } from 'vitest';

vi.mock('@ebda/database', () => ({
  currentStoreId: vi.fn(),
  prisma: {},
  Prisma: {
    sql: (...a: unknown[]) => a,
    raw: (s: string) => s,
    empty: '',
    join: (...a: unknown[]) => a,
  },
}));
vi.mock('./redis.service', () => ({
  // No Redis: forces the in-memory fallback whose cap M-127 asserts.
  redis: {
    get: vi.fn().mockRejectedValue(new Error('down')),
    set: vi.fn().mockRejectedValue(new Error('down')),
  },
}));

import {
  currentMonthStart,
  currentYearStart,
  getCachedAnalytics,
  analyticsMemCacheSize,
  ANALYTICS_MEM_CACHE_MAX,
} from './analytics.service';
import { regionMonthStart, regionYearMonth } from '@ebda/shared';

// M-124 (Ruling P18-2): month/year boundaries are Cairo midnight, not UTC midnight. The rollup service uses the same
// shared regionMonthStart/regionYearMonth helpers (its wrappers are module-private), so these pin the boundary for both.
describe('Cairo month boundary (M-124)', () => {
  it('Cairo midnight on 1 Nov is 22:00Z on 31 Oct while Egypt is +2 (winter, after the 2026-10-30 fall-back)', () => {
    expect(currentMonthStart(new Date('2026-11-15T12:00:00Z')).toISOString()).toBe(
      '2026-10-31T22:00:00.000Z'
    );
  });
  it('Cairo midnight on 1 Jul is 21:00Z on 30 Jun while Egypt is +3 (summer)', () => {
    expect(currentMonthStart(new Date('2026-07-10T12:00:00Z')).toISOString()).toBe(
      '2026-06-30T21:00:00.000Z'
    );
  });
  it('an instant just after midnight Cairo on the 1st belongs to the NEW month though UTC is still the old one', () => {
    const now = new Date('2026-11-30T22:30:00Z'); // 00:30 Cairo 1 Dec (+2); UTC says 30 Nov
    expect(regionYearMonth(now)).toBe('2026-12');
    expect(currentMonthStart(now).toISOString()).toBe('2026-11-30T22:00:00.000Z');
  });
  it('an instant just before midnight Cairo stays in the old month', () => {
    const now = new Date('2026-11-30T21:59:00Z'); // 23:59 Cairo 30 Nov
    expect(regionYearMonth(now)).toBe('2026-11');
    expect(currentMonthStart(now).toISOString()).toBe('2026-10-31T22:00:00.000Z');
  });
  it('year start is Cairo midnight on 1 Jan (+2)', () => {
    expect(currentYearStart(new Date('2026-06-01T00:00:00Z')).toISOString()).toBe(
      '2025-12-31T22:00:00.000Z'
    );
  });
  it('regionMonthStart round-trips through regionYearMonth', () => {
    expect(regionYearMonth(regionMonthStart('2026-03'))).toBe('2026-03');
    expect(regionYearMonth(new Date(regionMonthStart('2026-03').getTime() - 1))).toBe('2026-02');
  });
});

// M-127 (Ruling P18-1): the in-memory analytics cache is capped and evicts oldest-first.
describe('analytics in-memory cache cap (M-127)', () => {
  it('never exceeds ANALYTICS_MEM_CACHE_MAX and drops the oldest entries', async () => {
    const total = ANALYTICS_MEM_CACHE_MAX + 25;
    for (let i = 0; i < total; i++) {
      await getCachedAnalytics(`m127:${i}`, 3600, async () => i);
    }
    expect(analyticsMemCacheSize()).toBeLessThanOrEqual(ANALYTICS_MEM_CACHE_MAX);
    // oldest evicted -> fetchFn runs again; newest still cached -> fetchFn must not run
    let oldCalls = 0;
    await getCachedAnalytics('m127:0', 3600, async () => (oldCalls++, 'again'));
    expect(oldCalls).toBe(1);
    let newCalls = 0;
    await getCachedAnalytics(`m127:${total - 1}`, 3600, async () => (newCalls++, 'again'));
    expect(newCalls).toBe(0);
  });

  it('drops an expired entry on read instead of keeping it', async () => {
    vi.useFakeTimers();
    try {
      await getCachedAnalytics('m127:ttl', 120, async () => 'v1');
      vi.advanceTimersByTime(121_000);
      const v = await getCachedAnalytics('m127:ttl', 120, async () => 'v2');
      expect(v).toBe('v2');
    } finally {
      vi.useRealTimers();
    }
  });
});
