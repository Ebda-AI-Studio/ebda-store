/**
 * M-127 (Ruling P18-1): the analytics in-memory fallback cache evicts expired entries and is capped.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@api/services/redis.service', () => ({
  redis: {
    get: vi.fn(async () => {
      throw new Error('redis down');
    }),
    set: vi.fn(async () => {
      throw new Error('redis down');
    }),
  },
}));
vi.mock('@ebda/database', () => ({ prisma: {}, Prisma: { sql: () => '', raw: () => '' } }));
vi.mock('@api/services/accounting/reports.service', () => ({ profitAndLoss: vi.fn() }));

import {
  getCachedAnalytics,
  analyticsMemCacheSize,
  ANALYTICS_MEM_CACHE_MAX,
} from '@api/services/analytics.service';

describe('analytics in-memory cache', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('serves a live entry from memory and deletes an expired one on read', async () => {
    const fetch = vi.fn(async () => ({ n: 1 }));
    const before = analyticsMemCacheSize();
    await getCachedAnalytics('k-ttl', 10, fetch);
    await getCachedAnalytics('k-ttl', 10, fetch);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(analyticsMemCacheSize()).toBe(before + 1);
    vi.advanceTimersByTime(11_000);
    await getCachedAnalytics('k-ttl', 10, fetch); // expired: refetched and re-stored, not accumulated
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(analyticsMemCacheSize()).toBe(before + 1);
  });

  it('never grows past the cap, however many distinct keys arrive', async () => {
    for (let i = 0; i < ANALYTICS_MEM_CACHE_MAX * 3; i++) {
      await getCachedAnalytics(`k-many-${i}`, 3600, async () => ({ i }));
    }
    expect(analyticsMemCacheSize()).toBeLessThanOrEqual(ANALYTICS_MEM_CACHE_MAX);
  });

  it('drops expired entries before live ones when it has to evict', async () => {
    for (let i = 0; i < 100; i++) await getCachedAnalytics(`k-old-${i}`, 1, async () => i);
    vi.advanceTimersByTime(5_000); // the 100 are now expired
    for (let i = 0; i < ANALYTICS_MEM_CACHE_MAX; i++) {
      await getCachedAnalytics(`k-live-${i}`, 3600, async () => i);
    }
    const fetch = vi.fn(async () => 'x');
    await getCachedAnalytics(`k-live-${ANALYTICS_MEM_CACHE_MAX - 1}`, 3600, fetch); // newest live: still cached
    expect(fetch).not.toHaveBeenCalled();
    expect(analyticsMemCacheSize()).toBeLessThanOrEqual(ANALYTICS_MEM_CACHE_MAX);
  });
});
