/**
 * Defect: the dispatcher rendered `.en` only, so an Arabic shopper got English SMS and push.
 * The locale is now the order's / customer's stored locale, else the store default
 * (`settings.defaultLanguage`), else the region default (ar). The dispatcher is the only SMS /
 * shopper-push sender (the other `.en` hits are merchant-facing).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const h = vi.hoisted(() => ({
  storeSettings: { value: null as unknown },
  enqueue: vi.fn(),
  sendToStore: vi.fn(),
}));

vi.mock('@ebda/database', () => ({
  prisma: {},
  withStore: async (_id: string, fn: (tx: unknown) => unknown) =>
    fn({
      notificationEventConfig: { findUnique: async () => null },
      store: { findUnique: async () => ({ settings: h.storeSettings.value }) },
    }),
}));
// the store record is read through the store's own backend (storeDb); the event switches keep their withStore path (backend pg)
vi.mock('@api/lib/repo-factory', () => ({
  storeDb: async () => ({
    store: { findUnique: async () => ({ settings: h.storeSettings.value }) },
  }),
  storeRepo: async () => ({ backend: 'pg' }),
}));
vi.mock('@api/services/feature.service', () => ({
  featureService: { isFeatureEnabled: async () => true },
}));
vi.mock('@api/services/notification-config.service', () => ({
  notificationConfigService: {
    getConfig: async () => ({ enabled: true, credentials: { apiKey: 'k' } }),
  },
}));
vi.mock('@api/services/sms-queue.service', () => ({ smsQueue: { enqueue: h.enqueue } }));
vi.mock('@api/services/push.service', () => ({ pushService: { sendToStore: h.sendToStore } }));
vi.mock('@api/services/redis.service', () => ({
  redis: { incrementRateLimit: async () => 1 },
}));
vi.mock('@api/services/sms-consent.service', () => ({ SmsConsentService: {} }));
vi.mock('@api/lib/store-operational', async importOriginal => ({
  ...(await importOriginal<typeof import('@api/lib/store-operational')>()),
  storeOperational: async () => true,
  storeMayMessageCustomers: async () => true,
  assertStoreOperational: async () => undefined,
}));
vi.mock('@api/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@api/config', () => ({ config: { webUrl: 'https://ebda.app' } }));

import { notificationDispatcher } from '@api/services/notification-dispatcher.service';

const base = {
  customerName: 'سارة',
  customerPhone: '+201012345678',
  orderNumber: 'ORD-7',
  total: 55,
  storeId: 's1',
  storeName: 'متجر',
};
const ARABIC = /[ء-ي]/;

describe('dispatcher writes SMS and push in the shopper locale', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.storeSettings.value = null;
  });

  it('an Arabic order locale sends the Arabic SMS and push', async () => {
    await notificationDispatcher.dispatch('s1', 'order_shipped', {
      ...base,
      trackingNumber: 'T1',
      locale: 'ar',
    });
    expect(h.enqueue.mock.calls[0][0].messageText).toMatch(ARABIC);
    expect(h.enqueue.mock.calls[0][0].messageText).toContain('اتشحن');
    expect(h.sendToStore.mock.calls[0][1]).toBe('طلبك اتشحن');
    expect(h.sendToStore.mock.calls[0][2]).toMatch(ARABIC);
  });

  it('an English order locale sends English even when the store default is Arabic', async () => {
    h.storeSettings.value = { defaultLanguage: 'ar' };
    await notificationDispatcher.dispatch('s1', 'order_shipped', {
      ...base,
      customerName: 'Sara',
      storeName: 'Shop',
      locale: 'en',
    });
    expect(h.enqueue.mock.calls[0][0].messageText).not.toMatch(ARABIC);
    expect(h.sendToStore.mock.calls[0][1]).toBe('Order Shipped');
  });

  it('no stored locale: the store default language wins', async () => {
    h.storeSettings.value = { defaultLanguage: 'en' };
    await notificationDispatcher.dispatch('s1', 'order_shipped', base);
    expect(h.sendToStore.mock.calls[0][1]).toBe('Order Shipped');
  });

  it('no stored locale and no store default: Arabic (Egyptian region)', async () => {
    await notificationDispatcher.dispatch('s1', 'order_shipped', base);
    expect(h.enqueue.mock.calls[0][0].messageText).toMatch(ARABIC);
    expect(h.sendToStore.mock.calls[0][1]).toBe('طلبك اتشحن');
  });

  it('an unknown stored locale is ignored, not rendered as undefined', async () => {
    await notificationDispatcher.dispatch('s1', 'order_shipped', { ...base, locale: 'fr' });
    expect(h.sendToStore.mock.calls[0][1]).toBe('طلبك اتشحن');
  });
});

/**
 * Senders with NO stored shopper locale to thread: a wishlist user (`User.language` defaults to
 * 'en', so it is not a real choice) and a web abandoned cart. They fall to the store default,
 * then ar.
 */
const NO_STORED_LOCALE = ['inventory.service.ts', 'abandoned-cart.service.ts'];

describe('every dispatch call site threads the shopper locale', () => {
  const API = join(__dirname, '../../apps/api/src');
  const walk = (d: string, out: string[] = []): string[] => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p, out);
      else if (/\.ts$/.test(n) && !/\.test\./.test(n)) out.push(p);
    }
    return out;
  };
  it('each notificationDispatcher.dispatch( payload carries `locale`', () => {
    const missing: string[] = [];
    for (const f of walk(API)) {
      const src = readFileSync(f, 'utf8');
      if (f.endsWith('notification-dispatcher.service.ts')) continue;
      if (NO_STORED_LOCALE.some(n => f.endsWith(n))) continue;
      // payload either an object literal (locale inside) or a NotificationData variable
      for (const m of src.matchAll(
        /notificationDispatcher\.dispatch\(\s*[^,]+,\s*[^,]+,\s*\{([\s\S]*?)\n\s*\}\s*\)/g
      ))
        if (!/locale/.test(m[1])) missing.push(f);
    }
    expect(missing.map(f => f.replace(API, ''))).toEqual([]);
  });
});
