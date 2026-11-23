/**
 * Issue 2434 — the opt-out link's storefront-base cache stored the RESOLVED value, but the one
 * fan-out it exists for (back-in-stock: `notificationDispatcher.dispatch` per subscriber, NOT
 * awaited between recipients) starts every recipient before the first store read resolves, so all
 * N missed and N reads still hit the store. The cache now holds the in-flight promise.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  findUnique: vi.fn(),
}));

vi.mock('@ebda/database', () => ({
  prisma: { store: { findUnique: h.findUnique } },
  // `stores` is under RLS: the base is read inside the store's own scope (`withStore`).
  withStore: async (_id: string, fn: (tx: unknown) => unknown) =>
    fn({ store: { findUnique: h.findUnique } }),
}));
// the store record comes through the store's own backend (storeDb), not a Prisma tx
vi.mock('@api/lib/repo-factory', () => ({
  storeDb: async () => ({ store: { findUnique: h.findUnique } }),
  storeRepo: async () => ({ backend: 'do' }),
}));
vi.mock('@api/services/feature.service', () => ({ featureService: {} }));
vi.mock('@api/services/notification-config.service', () => ({ notificationConfigService: {} }));
vi.mock('@api/services/sms-queue.service', () => ({ smsQueue: {} }));
vi.mock('@api/services/push.service', () => ({ pushService: {} }));
vi.mock('@api/services/redis.service', () => ({ redis: {} }));
vi.mock('@api/services/sms-consent.service', () => ({ SmsConsentService: {} }));
vi.mock('@api/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@api/config', () => ({ config: { webUrl: 'https://ebda.app' } }));

import {
  __storefrontBaseForTests as storefrontBase,
  __clearOptOutBaseCacheForTests,
} from '@api/services/notification-dispatcher.service';

const tick = () => new Promise(r => setTimeout(r, 5));

describe('opt-out storefront base: concurrent recipients share one store read (issue 2434)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __clearOptOutBaseCacheForTests();
    h.findUnique.mockImplementation(async () => {
      await tick(); // the read is still in flight while the other recipients start
      return { domain: 'shop.example.test', slug: 'shop' };
    });
  });

  it('N un-awaited recipients issue ONE read, and all get the same base', async () => {
    const bases = await Promise.all(Array.from({ length: 25 }, () => storefrontBase('store-1')));
    expect(h.findUnique).toHaveBeenCalledTimes(1);
    expect(new Set(bases)).toEqual(new Set(['https://shop.example.test']));
  });

  it('a later sweep inside the TTL reuses the resolved read too', async () => {
    await storefrontBase('store-1');
    await storefrontBase('store-1');
    expect(h.findUnique).toHaveBeenCalledTimes(1);
  });

  it('different stores do not share a read', async () => {
    await Promise.all([storefrontBase('store-1'), storefrontBase('store-2')]);
    expect(h.findUnique).toHaveBeenCalledTimes(2);
  });

  it('a rejected read is not cached: the next recipient retries', async () => {
    h.findUnique.mockRejectedValueOnce(new Error('db down'));
    await expect(storefrontBase('store-1')).rejects.toThrow('db down');
    await expect(storefrontBase('store-1')).resolves.toBe('https://shop.example.test');
    expect(h.findUnique).toHaveBeenCalledTimes(2);
  });

  it('a missing store falls back to the platform base and is not cached', async () => {
    h.findUnique.mockResolvedValueOnce(null);
    expect(await storefrontBase('ghost')).toBe('https://ebda.app');
    await tick();
    expect(await storefrontBase('ghost')).toBe('https://shop.example.test');
    expect(h.findUnique).toHaveBeenCalledTimes(2);
  });
});
