/**
 * Ruling SUSPEND-OUT-1: a store whose status is not `active` sends nothing to its customers and
 * pays nothing out. One predicate (`lib/store-operational.ts`), called from every send entry point.
 * Each case below FAILS on the code before this change (the send / payout went through).
 * Kept allowed and asserted: the refund notice, the merchant's own test send, an active store unchanged.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const h = vi.hoisted(() => ({
  status: { value: 'suspended' as string | null },
  directory: [] as Array<{ id: string; status: string }>,
  enqueue: vi.fn(),
  sendToStore: vi.fn(),
  linked: vi.fn(),
  send: vi.fn(),
  money: vi.fn(),
  fetch: vi.fn(),
}));

vi.mock('@api/lib/definer', () => ({
  lookupStore: async (m: { id?: string }) =>
    h.status.value ? (h.status.value === 'active' ? { id: m.id, status: 'active' } : null) : null,
}));
vi.mock('@ebda/database', () => {
  const db = {
    notificationEventConfig: { findUnique: async () => null },
    store: {
      findUnique: async () => ({
        id: 's1',
        name: 'Shop',
        slug: 'shop',
        domain: null,
        email: 'o@shop.test',
        emailSenderLocalPart: null,
        emailDomainStatus: null,
        settings: null,
      }),
    },
  };
  return {
    prisma: db,
    withStore: async (_id: string, fn: (tx: unknown) => unknown) => fn(db),
    storeDirectory: async (f?: (s: { id: string; status: string }) => boolean) =>
      h.directory.filter(s => (f ? f(s) : true)),
    runInTenantContext: (_s: string, fn: () => unknown) => fn(),
    runInStoreScope: (_s: string, fn: () => unknown) => fn(),
  };
});
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
vi.mock('@api/services/sms-consent.service', () => ({ SmsConsentService: {} }));
vi.mock('@api/lib/repo-factory', () => ({
  storeRepo: async () => ({
    backend: 'pg',
    db: { notificationEventConfig: { findFirst: async () => null } },
  }),
}));
vi.mock('@api/lib/wa/link', () => ({ isWhatsAppLinked: h.linked, hasWhatsAppLinkRow: vi.fn() }));
vi.mock('@api/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@api/config', () => ({ config: { webUrl: 'https://ebda.app' } }));

import { clearCfBindings, setCfBindings } from '@api/cf/bindings';
import {
  activeStoreIds,
  assertStoreOperational,
  isStoreOperational,
} from '@api/lib/store-operational';
import { notificationDispatcher } from '@api/services/notification-dispatcher.service';
import { StoreMailer } from '@api/services/store-mailer.service';
import { emitStoreEventsFor } from '@api/lib/inngest/functions/wa-store-events';

const base = {
  customerName: 'Sara',
  customerPhone: '+201012345678',
  orderNumber: 'ORD-7',
  total: 55,
  storeId: 's1',
  storeName: 'Shop',
  locale: 'en' as const,
};

beforeEach(() => {
  vi.clearAllMocks();
  h.status.value = 'suspended';
  h.directory = [];
  clearCfBindings();
  setCfBindings({ EMAIL: { send: h.send.mockResolvedValue({ messageId: 'm1' }) } });
});

describe('the predicate', () => {
  it('only `active` is operational', () => {
    expect(isStoreOperational('active')).toBe(true);
    for (const s of ['suspended', 'inactive', '', null, undefined])
      expect(isStoreOperational(s)).toBe(false);
  });

  it('an admin refusal is 423 with a code and EN + AR copy', async () => {
    const err = await assertStoreOperational('s1').catch(e => e);
    expect(err).toMatchObject({ statusCode: 423, code: 'STORE_NOT_OPERATIONAL' });
    expect(err.details.messageEn).toMatch(/suspended/);
    expect(err.details.messageAr).toMatch(/[ء-ي]/);
    h.status.value = 'active';
    await expect(assertStoreOperational('s1')).resolves.toBeUndefined();
  });

  it('the sweep set holds only active stores', async () => {
    h.directory = [
      { id: 'a', status: 'active' },
      { id: 'b', status: 'suspended' },
      { id: 'c', status: 'inactive' },
    ];
    expect([...(await activeStoreIds())]).toEqual(['a']);
  });
});

describe('notification dispatcher (customer SMS + storefront push)', () => {
  it('a suspended store sends no order SMS and no push', async () => {
    for (const ev of [
      'order_confirmed',
      'order_shipped',
      'cart_abandoned_step1',
      'back_in_stock',
    ] as const)
      await notificationDispatcher.dispatch('s1', ev, base);
    expect(h.enqueue).not.toHaveBeenCalled();
    expect(h.sendToStore).not.toHaveBeenCalled();
  });

  it('an active store is unchanged', async () => {
    h.status.value = 'active';
    await notificationDispatcher.dispatch('s1', 'order_shipped', { ...base, trackingNumber: 'T' });
    expect(h.enqueue).toHaveBeenCalledTimes(1);
    expect(h.sendToStore).toHaveBeenCalledTimes(1);
  });

  it('the refund notice still goes out for a suspended store', async () => {
    await notificationDispatcher.dispatch('s1', 'refund_processed', { ...base, amount: 10 });
    expect(h.enqueue).toHaveBeenCalledTimes(1);
  });
});

describe('store mailer (campaign / cart-recovery / newsletter chokepoint)', () => {
  const store = { id: 's1', name: 'Shop', slug: 'shop', email: 'o@shop.test' };
  const msg = { to: 'a@x.test', subject: 'S', html: '<p/>' };

  it('a suspended store cannot send a marketing email or a newsletter batch', async () => {
    await expect(StoreMailer.sendMarketingEmail(store, msg)).rejects.toMatchObject({
      statusCode: 423,
    });
    await expect(
      StoreMailer.sendBrandedBatch('s1', {
        subject: 'S',
        messages: [{ to: 'a@x.test', html: '<p/>' }],
      })
    ).rejects.toMatchObject({ code: 'STORE_NOT_OPERATIONAL' });
    expect(h.send).not.toHaveBeenCalled();
  });

  it("the merchant's own test send is still allowed", async () => {
    await StoreMailer.sendMarketingEmail(store, { ...msg, toMerchant: true });
    expect(h.send).toHaveBeenCalledTimes(1);
  });

  it('an active store sends', async () => {
    h.status.value = 'active';
    await StoreMailer.sendMarketingEmail(store, msg);
    expect(h.send).toHaveBeenCalledTimes(1);
  });
});

describe('Ebda Chat events (WhatsApp order status, cart reminders)', () => {
  const ev = (name: string) => ({ id: 'e', name, data: { storeId: 's1', orderId: 'o1' } });

  it('a suspended store emits no customer-facing event, and does not even look up the link', async () => {
    for (const n of [
      'order/created',
      'order/status-changed',
      'shipment/status-updated',
      'cart/abandoned',
    ])
      expect(await emitStoreEventsFor(ev(n))).toBe(0);
    expect(h.linked).not.toHaveBeenCalled();
  });

  it('an active store proceeds to the link check', async () => {
    h.status.value = 'active';
    h.linked.mockResolvedValue(false);
    await emitStoreEventsFor(ev('order/status-changed'));
    expect(h.linked).toHaveBeenCalledTimes(1);
  });
});

// Entry points whose handlers are too wired to drive in a unit test (HTTP route + Inngest step bodies): pin that each
// still asks the one predicate. Removing the call fails here; the behaviour itself is proven in the cases above.
describe('guard presence at the wired entry points', () => {
  const root = join(__dirname, '../../apps/api/src');
  const cases: Array<[string, RegExp]> = [
    ['services/campaign.service.ts', /await assertStoreOperational\(storeId\)/],
    ['services/newsletter-broadcast.service.ts', /await assertStoreOperational\(storeId\)/],
    [
      'services/order-invoice-email.service.ts',
      /isPaidForReceipt\(order\.paymentStatus\)\) await assertStoreOperational/,
    ],
    ['lib/inngest/functions/invoice-email.ts', /!toMerchant[\s\S]*storeOperational\(storeId\)/],
    ['lib/inngest/functions/order-created.ts', /await storeOperational\(storeId\)/],
    ['lib/inngest/functions/order-status-changed.ts', /storeOperational\(storeId\)/],
    ['services/abandoned-cart.service.ts', /operational\.has\(storeId\)/],
    ['services/cart-recovery-email.service.ts', /skip\('store_not_active'\)/],
  ];
  it.each(cases)('%s', (file, re) => {
    expect(readFileSync(join(root, file), 'utf8')).toMatch(re);
  });
});
