/**
 * #630 residual: the per-store usage cache (60 s) was not updated after an upload, so a burst could pass the
 * ceiling (capped only by the 20/min rate limit). assertStorageRoom now reserves each upload's bytes.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const MB = 1024 * 1024;
const h = vi.hoisted(() => ({ listCalls: 0, listFails: false }));
vi.mock('@ebda/database', async () => {
  const mock = await import('./helpers/database-mock');
  return mock.databaseMock({
    prisma: {},
    extra: {
      withStore: async (_i: string, fn: any) =>
        fn({
          product: { count: async () => 3 },
          storeStaff: { count: async () => 1 },
          order: { count: async () => 2 },
          store: { findUnique: async () => ({ domain: null }) },
        }),
    },
  });
});
vi.mock('@api/services/plan-entitlements', async orig => ({
  ...(await orig<object>()),
  getEntitlements: async () => ({ limits: { maxStorageMb: 10 }, planCode: 'free' }),
}));
vi.mock('@api/services/storage.service', () => ({
  StorageService: {
    listStoreSizes: async () => {
      h.listCalls++;
      if (h.listFails) throw new Error('r2 down');
      return { sizes: [8 * MB], nextCursor: null };
    },
  },
}));

import { assertStorageRoom, getUsageSummary } from '@api/services/plan-limit.service';
import { releaseOnFailure, resetStorageUsageCache } from '@api/lib/storage-usage';

const S = '11111111-1111-4111-8111-111111111111';
beforeEach(() => {
  resetStorageUsageCache();
  h.listCalls = 0;
  h.listFails = false;
});

describe('assertStorageRoom reserves bytes (#630)', () => {
  it('a burst over the ceiling is refused although the listing is cached', async () => {
    // 8 MB used of 10: two 1 MB uploads fit, the third and later must be refused
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () => assertStorageRoom(S, 1 * MB))
    );
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(2);
    expect(results.filter(r => r.status === 'rejected')).toHaveLength(4);
    expect(h.listCalls).toBe(1);
  });

  it('a request that ends >= 400 releases its reservation; a 2xx keeps it', async () => {
    const fakeRes = (statusCode: number) => {
      const fns: Array<() => void> = [];
      return {
        statusCode,
        once: (_e: string, fn: () => void) => void fns.push(fn),
        end: () => fns.forEach(f => f()),
      };
    };
    // 8 of 10 MB used. Two failed 2 MB uploads must not eat the headroom...
    for (let i = 0; i < 2; i++) {
      const res = fakeRes(500);
      releaseOnFailure(res, await assertStorageRoom(S, 2 * MB));
      res.end();
    }
    // ...so a successful 2 MB upload still fits, and once kept, the next one is refused.
    const ok = fakeRes(200);
    releaseOnFailure(ok, await assertStorageRoom(S, 2 * MB));
    ok.end();
    await expect(assertStorageRoom(S, 1 * MB)).rejects.toMatchObject({ statusCode: 402 });
  });

  it('a refused upload reserves nothing', async () => {
    await expect(assertStorageRoom(S, 5 * MB)).rejects.toMatchObject({ statusCode: 402 });
    await expect(assertStorageRoom(S, 2 * MB)).resolves.toBeDefined();
  });

  it('release() is idempotent: calling it twice subtracts once', async () => {
    const a = await assertStorageRoom(S, 1 * MB); // 9 of 10
    a.release();
    a.release(); // would drop to 7 if it subtracted twice
    // 8 used again: exactly two 1 MB uploads fit, the third is refused
    await assertStorageRoom(S, 1 * MB);
    await assertStorageRoom(S, 1 * MB);
    await expect(assertStorageRoom(S, 1 * MB)).rejects.toMatchObject({ statusCode: 402 });
  });

  it('a release that lands after the cache refreshed is ignored (no under-count)', async () => {
    vi.useFakeTimers();
    try {
      const a = await assertStorageRoom(S, 1 * MB); // 8 -> 9 MB on generation 1
      vi.advanceTimersByTime(61_000); // TTL passes: the next read re-lists the bucket (8 MB on generation 2)
      await assertStorageRoom(S, 1 * MB); // refresh -> 9 MB
      a.release(); // old generation: must NOT take 1 MB off the fresh count
      await expect(assertStorageRoom(S, 2 * MB)).rejects.toMatchObject({ statusCode: 402 }); // 9+2 > 10
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('storage ceiling + usage (QA-STOR-1)', () => {
  it('a capped-plan store over its ceiling gets 402 with the Egyptian Arabic "storage full" message', async () => {
    const err = (await assertStorageRoom(S, 3 * MB).catch(e => e)) as {
      statusCode: number;
      details: Record<string, unknown>;
    };
    expect(err.statusCode).toBe(402);
    expect(err.details).toMatchObject({ limitKey: 'maxStorageMb', limit: 10, used: 8 });
    expect(String(err.details.messageAr)).toMatch(/[\u0600-\u06FF]/);
    expect(err.details.messageAr).not.toBe(err.details.messageEn);
  });
  it('the billing usage shows the used MB from the SAME counter the ceiling uses', async () => {
    const out = await getUsageSummary(S);
    expect(out.usage.maxStorageMb).toBe(8);
  });
  it('a failed listing is UNKNOWN on the billing page (null), never 0; the upload gate still fails open', async () => {
    h.listFails = true;
    expect((await getUsageSummary(S)).usage.maxStorageMb).toBeNull();
    resetStorageUsageCache();
    await expect(assertStorageRoom(S, 1 * MB)).resolves.toBeTruthy();
  });
});
