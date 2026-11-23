/**
 * NZ-SMS-READS-1: on the Worker a store lives in its Durable Object and there is no Postgres. The dispatcher's two store
 * reads (the shopper locale from `settings.defaultLanguage`, the storefront base for the SMS opt-out link) went through
 * `withStore`, a Postgres transaction: the locale silently fell back to the region default and the opt-out link threw.
 * They now read the DO store row like `getEventConfig` does. `withStore` here THROWS, as it does with Postgres removed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  backend: 'do' as 'do' | 'pg',
  row: null as unknown,
  repoError: null as unknown,
  findUnique: vi.fn(),
}));

vi.mock('@ebda/database', () => ({
  prisma: {},
  withStore: async () => {
    throw new Error('POSTGRES_REMOVED');
  },
}));
vi.mock('@api/lib/repo-factory', () => ({
  storeRepo: async () => {
    if (h.repoError) throw h.repoError;
    return { backend: h.backend, db: { store: { findUnique: h.findUnique } } };
  },
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
import { AppError } from '@api/middleware/error-handler';

describe('dispatcher store reads on a Durable Object store', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __clearOptOutBaseCacheForTests();
    h.backend = 'do';
    h.repoError = null;
    h.findUnique.mockImplementation(async () => h.row);
  });

  it("a store default of English is honoured (not the region default 'ar')", async () => {
    h.row = { settings: { defaultLanguage: 'en' } };
    expect(await resolveShopperLocale('s1', undefined)).toBe('en');
    expect(h.findUnique).toHaveBeenCalledWith({
      where: { id: 's1' },
      select: { settings: true },
    });
  });

  it('a stored order locale still wins without any read', async () => {
    expect(await resolveShopperLocale('s1', 'ar')).toBe('ar');
    expect(h.findUnique).not.toHaveBeenCalled();
  });

  it('no stored default falls back to the region default', async () => {
    h.row = { settings: {} };
    expect(await resolveShopperLocale('s1', undefined)).toBe('ar');
  });

  it('the opt-out base is the custom domain when the store has one', async () => {
    h.row = { domain: 'shop.example.test', slug: 'shop' };
    expect(await storefrontBase('s1')).toBe('https://shop.example.test');
  });

  it('the opt-out base is the slug host when there is no custom domain', async () => {
    h.row = { domain: null, slug: 'shop' };
    const base = await storefrontBase('s1');
    expect(base).toMatch(/^https:\/\/shop\./);
  });

  it('a gone store (410) falls back to the platform url and is not cached', async () => {
    h.repoError = new AppError(410, 'STORE_STORAGE_REMOVED', 'gone');
    expect(await storefrontBase('s1')).toBe('https://ebda.app');
    h.repoError = null;
    h.row = { domain: 'back.example.test', slug: 'b' };
    expect(await storefrontBase('s1')).toBe('https://back.example.test');
  });

  it('any other read failure still throws, so the dispatch fails loudly', async () => {
    h.repoError = new AppError(503, 'STORE_BACKEND_UNAVAILABLE', 'down');
    await expect(storefrontBase('s1')).rejects.toThrow();
  });
});
