/**
 * Money review M3 of #782: a provider ON with no activation ledger row is never silent. The revert-failed path pages ops
 * (P1, store + provider), and the daily reconcile reports every enabled API provider created after the ledger went live
 * that has no `activated_self` / `activated_admin` row.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  create: vi.fn(),
  findMany: vi.fn(),
  alert: vi.fn(async () => undefined),
  stores: [] as Array<{ id: string }>,
  pay: new Map<string, Array<{ provider: string; createdAt: Date }>>(),
  ship: new Map<string, Array<{ carrier: string; createdAt: Date }>>(),
}));

vi.mock('@ebda/database', async importOriginal => ({
  ...(await importOriginal<object>()),
  prisma: { providerVerificationEvent: { create: h.create, findMany: h.findMany } },
  withStore: (_s: string, fn: () => unknown) => fn(),
  storeDirectory: async () => h.stores,
}));
vi.mock('@api/lib/platform-scope', () => ({
  asOperator: (_u: string, fn: () => unknown) => fn(),
  platformHubOnD1: async () => false,
}));
vi.mock('@api/lib/repo-factory', () => ({
  storeDb: async (id: string) => ({
    paymentConfig: { findMany: async () => h.pay.get(id) ?? [] },
    shippingCarrierConfig: { findMany: async () => h.ship.get(id) ?? [] },
  }),
  storeWriter: vi.fn(),
  storeRepo: vi.fn(),
}));
vi.mock('@api/services/alerts.service', () => ({ sendAlert: h.alert }));
vi.mock('@api/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  recordAdminEnable,
  reconcileUnledgeredEnables,
} from '../../apps/api/src/services/provider-activation.service';

const LIVE = new Date('2026-11-18T00:00:00Z');
beforeEach(() => {
  vi.clearAllMocks();
  h.stores = [{ id: 's1' }, { id: 's2' }];
  h.pay.clear();
  h.ship.clear();
});

describe('M3: an enable that lost its ledger row pages ops', () => {
  it('ledger write fails AND the switch-off fails: P1 naming the store and provider, the error still surfaces', async () => {
    h.create.mockRejectedValueOnce(new Error('d1 down'));
    await expect(
      recordAdminEnable({
        storeId: 's1',
        provider: 'kashier',
        mode: 'live',
        revert: async () => {
          throw new Error('do down');
        },
      })
    ).rejects.toThrow('d1 down');
    expect(h.alert).toHaveBeenCalledWith(
      expect.objectContaining({
        level: 'p1',
        source: 'provider.activation.unledgered_enable',
        context: { storeId: 's1', provider: 'kashier' },
      })
    );
  });
  it('the switch-off worked: no alert (the provider is off again)', async () => {
    h.create.mockRejectedValueOnce(new Error('d1 down'));
    await expect(
      recordAdminEnable({
        storeId: 's1',
        provider: 'kashier',
        mode: 'live',
        revert: async () => undefined,
      })
    ).rejects.toThrow('d1 down');
    expect(h.alert).not.toHaveBeenCalled();
  });
});

describe('M3: the daily reconcile', () => {
  const ledger = (rows: Array<{ provider?: string; store?: string }>) =>
    h.findMany.mockImplementation(async ({ where, orderBy }: any) => {
      if (orderBy?.[0]?.createdAt === 'asc')
        return [{ op: 'activation.activated_self', createdAt: LIVE }];
      return rows.some(r => r.provider === where.provider && r.store === where.sourceStoreId)
        ? [{ op: 'activation.activated_admin', createdAt: LIVE }]
        : [];
    });

  it('reports an enabled API provider created after the ledger went live with no activation row, once, as P1', async () => {
    h.pay.set('s1', [
      { provider: 'kashier', createdAt: new Date('2026-11-20T00:00:00Z') }, // no row -> reported
      { provider: 'paymob', createdAt: new Date('2026-11-20T00:00:00Z') }, // has a row -> fine
      { provider: 'cod', createdAt: new Date('2026-11-20T00:00:00Z') }, // manual -> never
    ]);
    h.ship.set('s2', [{ carrier: 'bosta', createdAt: new Date('2026-10-01T00:00:00Z') }]); // before the ledger -> legacy
    ledger([{ provider: 'paymob', store: 's1' }]);
    expect(await reconcileUnledgeredEnables()).toEqual([{ storeId: 's1', provider: 'kashier' }]);
    expect(h.alert).toHaveBeenCalledTimes(1);
    expect(h.alert.mock.calls[0][0]).toMatchObject({
      level: 'p1',
      body: expect.stringContaining('s1/kashier'),
    });
  });
  it('nothing missing: silent; no ledger row at all yet: nothing is measured', async () => {
    h.pay.set('s1', [{ provider: 'kashier', createdAt: new Date('2026-11-20T00:00:00Z') }]);
    ledger([{ provider: 'kashier', store: 's1' }]);
    expect(await reconcileUnledgeredEnables()).toEqual([]);
    h.findMany.mockResolvedValue([]);
    expect(await reconcileUnledgeredEnables()).toEqual([]);
    expect(h.alert).not.toHaveBeenCalled();
  });
});
