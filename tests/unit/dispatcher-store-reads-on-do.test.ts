/**
 * NZ-PORT-2: the notification dispatcher's two store reads on a Durable Object store. `resolveShopperLocale` and the opt-out link's
 * storefront base read the store through Prisma `withStore`: on the Worker that throws POSTGRES_REMOVED (the locale silently fell back to
 * the region default `ar` for a store whose default language is `en`; the base read threw, so no promotional SMS could carry its opt-out
 * link). Here `prisma` THROWS and the store comes from `storeDb`: a path that still reaches Postgres fails the test.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({ record: null as null | Record<string, unknown> }));

vi.mock('@ebda/database', () => ({
  prisma: new Proxy(
    {},
    {
      get: (_t, p) => {
        throw new Error(`Postgres touched: prisma.${String(p)}`);
      },
    }
  ),
  // the lazy scope wrapper the real package exposes: it runs the callback, never opens Postgres for a DO store
  withStore: async (_id: string, fn: (tx: unknown) => unknown) =>
    fn(
      new Proxy(
        {},
        {
          get: (_t, p) => {
            throw new Error(`Postgres touched: tx.${String(p)}`);
          },
        }
      )
    ),
}));
vi.mock('@api/lib/repo-factory', () => ({
  storeDb: async () => ({ store: { findUnique: async () => h.record } }),
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
  resolveShopperLocale,
  __storefrontBaseForTests as storefrontBase,
  __clearOptOutBaseCacheForTests,
} from '@api/services/notification-dispatcher.service';

describe('dispatcher store reads on a DO store (no Postgres)', () => {
  beforeEach(() => {
    __clearOptOutBaseCacheForTests();
    h.record = null;
  });

  it("resolveShopperLocale answers the store's own default language, not the region default", async () => {
    h.record = { settings: { defaultLanguage: 'en' } };
    expect(await resolveShopperLocale('store-1', undefined)).toBe('en');
    h.record = { settings: { defaultLanguage: 'ar' } };
    expect(await resolveShopperLocale('store-1', undefined)).toBe('ar');
    expect(await resolveShopperLocale('store-1', 'en')).toBe('en'); // a stored locale never reads the store
  });

  it('the opt-out base is the store custom domain, else its platform slug origin', async () => {
    h.record = { domain: 'shop.example.test', slug: 'shop' };
    expect(await storefrontBase('store-a')).toBe('https://shop.example.test');
    h.record = { domain: null, slug: 'my-shop' };
    expect(await storefrontBase('store-b')).toMatch(/^https:\/\/my-shop\./);
  });

  it('a missing store falls back to the platform base (and is not cached)', async () => {
    h.record = null;
    expect(await storefrontBase('ghost')).toBe('https://ebda.app');
  });
});
