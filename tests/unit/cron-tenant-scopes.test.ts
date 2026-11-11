import { beforeEach, describe, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({
  scope: '',
  stores: ['store-a', 'store-b'],
  seen: [] as string[],
  feature: vi.fn(),
  send: vi.fn(),
}));
vi.mock('@ebda/database', () => ({
  prisma: {
    // Per-store settings are read INSIDE the store's scope, never from an unscoped list.
    store: {
      findUnique: async ({ where }: { where: { id: string } }) => {
        if (!m.scope) throw new Error('unscoped store read');
        return { id: where.id, loyaltySettings: {} };
      },
    },
    storeFeature: {
      findMany: async () => {
        if (!m.scope) throw new Error('unscoped feature');
        return [{ storeId: m.scope }];
      },
    },
    cart: {
      findMany: async () => {
        if (!m.scope) throw new Error('unscoped cart');
        m.seen.push(`cart:${m.scope}`);
        return [];
      },
    },
    abandonedCartConfig: {
      findUnique: async () => null,
      upsert: async () => ({ step1Enabled: true, step1DelayMinutes: 60 }),
    },
    abandonedCart: {
      findMany: async () => {
        if (!m.scope) throw new Error('unscoped reminder');
        return [{ id: m.scope, storeId: m.scope, status: 'pending' }];
      },
    },
    loyaltyTransaction: {
      findMany: async () => {
        if (!m.scope) throw new Error('unscoped expiration');
        m.seen.push(`expire:${m.scope}`);
        return [];
      },
    },
  },
  runInStoreScope: async (id: string, fn: () => Promise<unknown>) => {
    m.scope = id;
    try {
      return await fn();
    } finally {
      m.scope = '';
    }
  },
  // `stores` is under RLS: crons list stores through the directory definer.
  storeDirectory: async (filter?: (s: Record<string, unknown>) => boolean) =>
    m.stores.map(id => ({ id, loyaltyEnabled: true })).filter(s => (filter ? filter(s) : true)),
  withStore: async (id: string, fn: (tx: unknown) => Promise<unknown>) => {
    m.scope = id;
    try {
      return await fn({});
    } finally {
      m.scope = '';
    }
  },
  acrossStores: vi.fn(),
  // the real helper hands the store id to the callback
  acrossStoresFlat: async (fn: (storeId: string) => Promise<unknown[]>) => {
    const result: unknown[] = [];
    for (const id of m.stores) {
      m.scope = id;
      try {
        result.push(...(await fn(id)));
      } finally {
        m.scope = '';
      }
    }
    return result;
  },
}));
vi.mock('@api/services/feature.service', () => ({
  featureService: { isFeatureEnabled: m.feature, selectEnabled: async (ids: string[]) => ids },
}));
vi.mock('@api/services/redis.service', () => ({ redis: {} }));
vi.mock('@api/services/notification-dispatcher.service', () => ({ notificationDispatcher: {} }));
vi.mock('@api/services/bundle.service', () => ({ resolveBundle: vi.fn() }));
import { loyaltyAutomationService } from '@api/services/loyalty-automation.service';
import { abandonedCartService } from '@api/services/abandoned-cart.service';
beforeEach(() => {
  m.scope = '';
  m.seen = [];
  m.feature.mockImplementation(async (id: string, key?: string) => {
    // Cart detection asks the effective entitlement per store (plan baseline OR row); featureService
    // opens its own store scope, so it is called from outside one.
    if (key === 'abandoned_cart') return true;
    expect(m.scope).toBe(id);
    m.seen.push(`birthday:${id}`);
    return false;
  });
  vi.restoreAllMocks();
});
describe('platform cron visits each tenant with its own scope', () => {
  it('scopes birthday feature reads and expiration scans for both stores', async () => {
    await loyaltyAutomationService.processBirthdayBonuses();
    await loyaltyAutomationService.processPointExpiration();
    expect(m.seen).toEqual([
      'birthday:store-a',
      'birthday:store-b',
      'expire:store-a',
      'expire:store-b',
    ]);
  });
  it('scopes website cart detection and the complete reminder send', async () => {
    await abandonedCartService.detectNewAbandonments();
    expect(m.seen).toEqual(['cart:store-a', 'cart:store-b']);
    const send = vi.spyOn(abandonedCartService, 'sendStep').mockImplementation(async cart => {
      expect(m.scope).toBe(cart.storeId);
      m.seen.push(`send:${cart.storeId}`);
    });
    await abandonedCartService.processReminders();
    expect(send).toHaveBeenCalledTimes(2);
    expect(m.seen.slice(2)).toEqual(['send:store-a', 'send:store-b']);
  });
});
