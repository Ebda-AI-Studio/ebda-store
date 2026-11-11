/**
 * #630 residual: the per-store usage cache (60 s) was not updated after an upload, so a burst could pass the
 * ceiling (capped only by the 20/min rate limit). assertStorageRoom now reserves each upload's bytes.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const MB = 1024 * 1024;
const h = vi.hoisted(() => ({ listCalls: 0 }));
vi.mock('@ebda/database', async () => {
  const mock = await import('./helpers/database-mock');
  return mock.databaseMock({
    prisma: {},
    extra: { withStore: async (_i: string, fn: any) => fn({}) },
  });
});
vi.mock('@api/services/plan-entitlements', async orig => ({
  ...(await orig<object>()),
  getEntitlements: async () => ({ limits: { maxStorageMb: 10 }, planCode: 'free' }),
}));
vi.mock('@api/services/storage.service', () => ({
  StorageService: {
    listStoreSizes: async () => (h.listCalls++, { sizes: [8 * MB], nextCursor: null }),
  },
}));

import { assertStorageRoom } from '@api/services/plan-limit.service';
import { resetStorageUsageCache } from '@api/lib/storage-usage';

const S = '11111111-1111-4111-8111-111111111111';
beforeEach(() => {
  resetStorageUsageCache();
  h.listCalls = 0;
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

  it('a refused upload releases its reservation', async () => {
    await expect(assertStorageRoom(S, 5 * MB)).rejects.toMatchObject({ statusCode: 402 });
    await expect(assertStorageRoom(S, 2 * MB)).resolves.toBeUndefined();
  });
});
