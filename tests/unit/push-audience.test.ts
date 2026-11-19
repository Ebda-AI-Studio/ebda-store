/**
 * Ruling PUSH-AUDIENCE-1: shopper A's order details must never reach shopper B's device.
 *  - every SHOPPER-facing push (transactional or promotional) goes only to that customer's own storefront subscriptions;
 *    no customer id = no push (fail closed), at the dispatcher AND at the push service;
 *  - STAFF pushes (orders app) go only to 'orders_app' subscriptions;
 *  - every dispatch call site passes the customer id (a source scan, so a new caller cannot forget it).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const h = vi.hoisted(() => ({
  findMany: vi.fn(async (_a: unknown) => [
    { id: 'sub1', endpoint: 'https://push.example/1', p256dh: 'k', auth: 'a' },
  ]),
  send: vi.fn(async () => ({})),
}));

vi.mock('web-push', () => ({
  default: { setVapidDetails: vi.fn(), sendNotification: h.send },
}));
vi.mock('@api/config', () => ({
  config: { vapidPublicKey: 'pub', vapidPrivateKey: 'priv', vapidSubject: 'mailto:a@b.c' },
}));
vi.mock('@api/lib/analytics-backend', () => ({ analyticsWrite: vi.fn(async () => undefined) }));
vi.mock('@ebda/database', () => ({
  currentStoreId: () => 's1',
  prisma: { pushSubscription: { upsert: vi.fn(), deleteMany: vi.fn() } },
  withStore: async (_id: string, fn: (tx: unknown) => unknown) => fn({}),
  runInTenantContext: async (_id: string, fn: () => unknown) => fn(),
}));
vi.mock('@api/lib/jobs/store-db', () => ({
  withStoreRw: async (_id: string, fn: (tx: unknown) => unknown) =>
    fn({
      pushSubscription: { findMany: h.findMany, deleteMany: vi.fn() },
      notificationLog: { create: vi.fn() },
      notificationEventConfig: { findUnique: async () => ({ push: true }) },
    }),
}));
vi.mock('@api/services/notification-config.service', () => ({
  notificationConfigService: {
    getConfig: async () => ({ enabled: true, credentials: {} }),
    getEventConfigs: async () => ({}),
  },
}));
vi.mock('@api/lib/store-operational', () => ({ assertStoreOperational: async () => undefined }));
vi.mock('@api/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { pushService } = await import('@api/services/push.service');

describe('PushService: the shopper push is addressed, never broadcast', () => {
  beforeEach(() => {
    h.findMany.mockClear();
    h.send.mockClear();
  });

  it('a call with no audience sends nothing and reads no subscription (fail closed)', async () => {
    await pushService.sendToStore('s1', 't', 'b', undefined, undefined as never);
    await pushService.sendToStore('s1', 't', 'b', undefined, {} as never);
    await pushService.sendToStore('s1', 't', 'b', undefined, { customerId: '' });
    expect(h.findMany).not.toHaveBeenCalled();
    expect(h.send).not.toHaveBeenCalled();
  });

  it("shopper class: reads only that customer's own storefront subscriptions", async () => {
    await pushService.sendToStore('s1', 't', 'b', { event: 'order_shipped' }, { customerId: 'u1' });
    const where = (h.findMany.mock.calls[0]![0] as { where: Record<string, unknown> }).where;
    expect(where).toEqual({ storeId: 's1', customerId: 'u1', audience: 'storefront' });
    expect(h.send).toHaveBeenCalledTimes(1);
  });

  it('merchant broadcast (the ONE store-wide push): reaches EVERY consented storefront device, not one customer', async () => {
    const devices = [1, 2, 3].map(n => ({
      id: `sub${n}`,
      endpoint: `https://push.example/${n}`,
      p256dh: 'k',
      auth: 'a',
    }));
    h.findMany.mockResolvedValueOnce(devices);
    const res = await pushService.broadcastToStore('s1', {
      titleEn: 'Sale',
      titleAr: 'تخفيضات',
      bodyEn: 'Today',
      bodyAr: 'النهاردة',
    });
    const where = (h.findMany.mock.calls[0]![0] as { where: Record<string, unknown> }).where;
    // every storefront device of the store (the shopper's own subscription is the consent), no customer filter, no staff devices
    expect(where).toEqual({ storeId: 's1', audience: 'storefront' });
    expect(h.send).toHaveBeenCalledTimes(3);
    expect(res).toMatchObject({ recipients: 3, delivered: 3, failed: 0 });
  });

  it('and the transactional push right after it still reaches only the one customer', async () => {
    await pushService.sendToStore(
      's1',
      't',
      'b',
      { event: 'order_confirmed' },
      { customerId: 'u9' }
    );
    const where = (h.findMany.mock.calls[0]![0] as { where: Record<string, unknown> }).where;
    expect(where).toEqual({ storeId: 's1', customerId: 'u9', audience: 'storefront' });
  });

  it('staff class: the orders-app push reads only orders_app subscriptions (never shoppers)', async () => {
    await pushService.sendToOrdersAppStaff('s1', 't', 'b', { tag: 'x' });
    expect(h.findMany).toHaveBeenCalledTimes(1);
    const where = (h.findMany.mock.calls[0]![0] as { where: Record<string, unknown> }).where;
    expect(where).toEqual({ storeId: 's1', audience: 'orders_app' });
  });
});

const API = join(__dirname, '../../apps/api/src');
const walk = (d: string): string[] =>
  readdirSync(d).flatMap(n => {
    const p = join(d, n);
    if (statSync(p).isDirectory()) return walk(p);
    return /\.ts$/.test(n) && !/\.test\./.test(n) ? [p] : [];
  });

describe('every caller is classified', () => {
  const files = walk(API);

  it('sendToStore (the shopper push) is called only by the dispatcher', () => {
    const callers = files
      .filter(f => /\.sendToStore\(/.test(readFileSync(f, 'utf8')))
      .map(f => f.replace(API + '/', ''));
    expect(callers).toEqual(['services/notification-dispatcher.service.ts']);
  });

  it('every notificationDispatcher.dispatch call passes a customerId (shopper class)', () => {
    const missing: string[] = [];
    let seen = 0;
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      for (const m of src.matchAll(/notificationDispatcher\.dispatch\(/g)) {
        seen++;
        const chunk = src.slice(m.index!, m.index! + 900);
        // the call's argument object ends at the first closing of the call: look at the text up to it
        const body = chunk.slice(0, chunk.indexOf('});') > 0 ? chunk.indexOf('});') : 900);
        // abandoned-cart builds `notificationData` first (checked by the data literal in that file)
        if (!/customerId/.test(body) && !/notificationData/.test(body))
          missing.push(`${f.replace(API + '/', '')}@${m.index}`);
      }
    }
    expect(seen).toBeGreaterThanOrEqual(7);
    expect(missing).toEqual([]);
    expect(readFileSync(join(API, 'services/abandoned-cart.service.ts'), 'utf8')).toContain(
      'customerId: abandonedCart.customerId ?? undefined'
    );
  });

  it('the storefront subscribe route binds the logged-in customer (it had no auth middleware)', () => {
    const src = readFileSync(join(API, 'routes/notification.routes.ts'), 'utf8');
    expect(src).toContain('optionalAuthenticate');
    expect(src).toContain('customerUserId(req)');
  });
});
