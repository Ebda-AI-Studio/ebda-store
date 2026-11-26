/**
 * QA-CART-1 follow-up: every abandoned-cart reminder step (and back-in-stock) is PROMOTIONAL. SMS needs an ACTIVE
 * SMS-marketing consent row for the phone; push goes only to the addressed shopper's own devices (their subscription is
 * their opt-in), never as a store-wide broadcast of one shopper's name and cart. No consent / unknown recipient / revoked
 * = no send (unknown is not yes). The push half was a real leak: sendToStore reached EVERY subscription of the store.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  enqueue: vi.fn(),
  sendToStore: vi.fn(),
  findActive: vi.fn(),
}));

vi.mock('@ebda/database', () => ({
  prisma: {},
  withStore: async (_id: string, fn: (tx: unknown) => unknown) =>
    fn({
      notificationEventConfig: { findUnique: async () => null },
      store: {
        findUnique: async () => ({ settings: null, slug: 's1', domain: null, name: 'متجر' }),
      },
    }),
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
vi.mock('@api/services/redis.service', () => ({ redis: { incrementRateLimit: async () => 1 } }));
vi.mock('@api/services/sms-consent.service', () => ({
  SmsConsentService: { findActiveForPhone: h.findActive },
}));
vi.mock('@api/lib/store-operational', async importOriginal => ({
  ...(await importOriginal<typeof import('@api/lib/store-operational')>()),
  storeOperational: async () => true,
  storeMayMessageCustomers: async () => true,
  assertStoreOperational: async () => undefined,
}));
vi.mock('@api/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@api/lib/sms-consent', async importOriginal => ({
  ...(await importOriginal<typeof import('@api/lib/sms-consent')>()),
  signSmsOptOutToken: () => 'tok',
}));
vi.mock('@api/config', () => ({ config: { webUrl: 'https://ebda.app' } }));

import { notificationDispatcher } from '@api/services/notification-dispatcher.service';

const cart = {
  customerName: 'سارة',
  customerPhone: '+201012345678',
  orderNumber: 'ac-1',
  storeId: 's1',
  storeName: 'متجر',
  cartUrl: 'https://s1.ebda.app/cart',
  cartTotal: '4.850',
  cartItemCount: 1,
};

describe('abandoned-cart steps: consent per channel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.findActive.mockResolvedValue(null);
  });

  for (const step of [1, 2, 3] as const) {
    const event = `cart_abandoned_step${step}` as const;

    it(`step ${step} SMS: no active consent row (none, unknown or revoked) sends nothing`, async () => {
      await notificationDispatcher.dispatch('s1', event, { ...cart, customerId: 'u1' });
      expect(h.findActive).toHaveBeenCalledWith('s1', '+201012345678');
      expect(h.enqueue).not.toHaveBeenCalled();
    });

    it(`step ${step} SMS: an active consent row sends, with the opt-out link`, async () => {
      h.findActive.mockResolvedValue({ id: 'c1' });
      await notificationDispatcher.dispatch('s1', event, { ...cart, customerId: 'u1' });
      expect(h.enqueue).toHaveBeenCalledTimes(1);
      expect(h.enqueue.mock.calls[0][0].messageText).toContain('sms-unsubscribe');
    });

    it(`step ${step} push: no addressed shopper means no push at all (never a store broadcast)`, async () => {
      await notificationDispatcher.dispatch('s1', event, cart);
      expect(h.sendToStore).not.toHaveBeenCalled();
    });

    it(`step ${step} push: goes only to the addressed shopper's own devices`, async () => {
      await notificationDispatcher.dispatch('s1', event, { ...cart, customerId: 'u1' });
      expect(h.sendToStore).toHaveBeenCalledTimes(1);
      expect(h.sendToStore.mock.calls[0][4]).toEqual({ customerId: 'u1' });
    });
  }

  it('back-in-stock is promotional too: no recipient, no push', async () => {
    await notificationDispatcher.dispatch('s1', 'back_in_stock', { ...cart, productName: 'خاتم' });
    expect(h.sendToStore).not.toHaveBeenCalled();
  });

  it('a transactional event is shopper-facing too: own devices with an id, nothing without one', async () => {
    await notificationDispatcher.dispatch('s1', 'order_shipped', { ...cart, orderNumber: 'ORD-1' });
    expect(h.sendToStore).not.toHaveBeenCalled();
    await notificationDispatcher.dispatch('s1', 'order_shipped', {
      ...cart,
      orderNumber: 'ORD-1',
      customerId: 'u1',
    });
    expect(h.sendToStore).toHaveBeenCalledTimes(1);
    expect(h.sendToStore.mock.calls[0][4]).toEqual({ customerId: 'u1' });
  });
});
