/**
 * SELF-SERVICE A8/A9 through the REAL settlement path (`settleInTx`): a succeeded payment grants its term exactly
 * once even when the same delivery arrives again, a failed payment grants nothing, and a failing grant write
 * surfaces (so the payment transaction rolls back and the gateway redelivers).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const inv = vi.hoisted(() => ({ invalidate: vi.fn(), entity: vi.fn() }));
vi.mock('@api/lib/definer', () => ({
  getEntityStoreId: inv.entity,
  getBillingRefundStoreId: vi.fn(),
}));
vi.mock('@api/services/feature.service', () => ({
  featureService: { invalidateCache: inv.invalidate },
}));
vi.mock('@api/services/billing/grants.service', async () => ({
  ...(await vi.importActual<Record<string, unknown>>('@api/services/billing/grants.service')),
  revokeGrantsForEvent: async () => [],
  restoreRevokedGrants: async () => undefined,
}));
vi.mock('@api/services/platform/billing-d1', async () => {
  const real = await vi.importActual<Record<string, unknown>>('@api/services/platform/billing-d1');
  return { ...real, onD1: async () => false };
});
vi.mock('@ebda/database', () => ({
  prisma: {},
  withStore: async (_id: string, fn: (t: unknown) => unknown) => fn(refundTx),
  acrossStores: vi.fn(),
  storeDirectory: vi.fn(),
  currentStoreId: () => 's1',
}));
vi.mock('@api/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { refundCharge, settleInTx } from '@api/services/billing/subscription-billing.service';

const NOW = new Date('2026-11-14T10:00:00.000Z');
const row = {
  id: 'e1',
  storeId: 's1',
  subscriptionId: null,
  type: 'upgrade',
  planCode: 'addon:feature:floating_widget',
  billingInterval: null,
  forPeriodEnd: null,
  attempt: 0,
  amountMinor: 9900,
  provider: 'kashier',
  status: 'pending',
  createdAt: NOW,
  failureReason: null,
};

/** A ledger whose status transition is real: only the first pending -> succeeded update counts. */
function fakeTx(grantFails = false) {
  let status = 'pending';
  const grants: unknown[] = [];
  const tx: any = {
    billingEvent: {
      findUnique: async () => ({ ...row, status }),
      findFirst: async () => null,
      updateMany: vi.fn(async ({ where, data }: any) => {
        if (data.status) {
          if (
            data.status === 'succeeded' &&
            ['pending', 'failed'].includes(status) &&
            where.status.in
          ) {
            status = 'succeeded';
            return { count: 1 };
          }
          if (data.status === 'failed' && where.status === 'pending' && status === 'pending') {
            status = 'failed';
            return { count: 1 };
          }
          return { count: 0 };
        }
        if (grantFails) throw new Error('grant write failed');
        grants.push(data);
        return { count: 1 };
      }),
    },
    storeFeature: { findFirst: async () => null },
    storeSubscription: { findUnique: async () => null },
  };
  return { tx, grants, status: () => status };
}

beforeEach(() => vi.clearAllMocks());

describe('add-on payment settlement', () => {
  it('grants once: the replayed success is a no-op', async () => {
    const f = fakeTx();
    const effects: any[] = [];
    const a = await settleInTx(
      f.tx,
      'e1',
      { status: 'succeeded', providerRef: 'p1' },
      NOW,
      effects
    );
    const b = await settleInTx(
      f.tx,
      'e1',
      { status: 'succeeded', providerRef: 'p1' },
      NOW,
      effects
    );
    expect(a.transitioned).toBe(true);
    expect(b.transitioned).toBe(false);
    expect(f.grants).toHaveLength(1);
    expect(effects.filter(e => e.kind === 'addon_granted')).toHaveLength(1);
  });
  it('a failed payment grants nothing', async () => {
    const f = fakeTx();
    const effects: any[] = [];
    await settleInTx(f.tx, 'e1', { status: 'failed', failureReason: 'declined' }, NOW, effects);
    expect(f.grants).toHaveLength(0);
    expect(effects).toEqual([]);
    expect(f.status()).toBe('failed');
  });
  it('a late failure after the success does not take the grant away', async () => {
    const f = fakeTx();
    await settleInTx(f.tx, 'e1', { status: 'succeeded' }, NOW, []);
    await settleInTx(f.tx, 'e1', { status: 'failed' }, NOW, []);
    expect(f.status()).toBe('succeeded');
    expect(f.grants).toHaveLength(1);
  });
  it('a failing grant write is surfaced, never swallowed', async () => {
    const f = fakeTx(true);
    await expect(settleInTx(f.tx, 'e1', { status: 'succeeded' }, NOW, [])).rejects.toThrow(
      'grant write failed'
    );
  });
});

/** Finding 4 of the review: a refunded add-on is not an entitlement any more, and the cache must say so at once. */
const refundTx: any = {
  billingEvent: {
    findUnique: vi.fn(),
    findMany: async () => [],
    createMany: async () => ({ count: 1 }),
    updateMany: async () => ({ count: 1 }),
    aggregate: async () => ({ _sum: { amountMinor: 9900 } }),
  },
  billingGrant: { findMany: async () => [], updateMany: async () => ({ count: 0 }) },
  // R-REFUND-PERIOD-1 (main): a full plan refund reads the subscription to decide whether access ends.
  storeSubscription: { findUnique: vi.fn(async () => null), update: vi.fn(async () => ({})) },
  plan: { findUnique: vi.fn(async () => null) },
};

describe('refund of an add-on payment', () => {
  const charge = (planCode: string) => ({
    id: 'c1',
    storeId: 's1',
    subscriptionId: null,
    type: 'upgrade',
    status: 'succeeded',
    providerRef: 'p1',
    provider: 'kashier',
    amountMinor: 9900,
    planCode,
  });
  const provider = {
    name: 'kashier',
    refund: async () => ({ status: 'succeeded', refundId: 'r1' }),
  } as any;
  beforeEach(() => {
    inv.entity.mockResolvedValue('s1');
    refundTx.billingEvent.findUnique.mockReset();
    refundTx.storeSubscription.findUnique.mockClear();
  });
  it('drops the cached feature map as soon as the refund settles', async () => {
    refundTx.billingEvent.findUnique.mockImplementation(async ({ where }: any) =>
      where.id === 'c1'
        ? charge('addon:feature:floating_widget')
        : { id: where.id, relatedEventId: 'c1', storeId: 's1' }
    );
    await refundCharge({ eventId: 'c1', provider });
    expect(inv.invalidate).toHaveBeenCalledWith('s1');
    // an add-on refund never goes near the plan period (R-REFUND-PERIOD-1 must not downgrade the store)
    expect(refundTx.storeSubscription.findUnique).not.toHaveBeenCalled();
  });
  it('a plan refund does not touch the feature cache from this path', async () => {
    refundTx.billingEvent.findUnique.mockImplementation(async ({ where }: any) =>
      where.id === 'c1' ? charge('growth') : { id: where.id, relatedEventId: 'c1', storeId: 's1' }
    );
    await refundCharge({ eventId: 'c1', provider });
    expect(inv.invalidate).not.toHaveBeenCalled();
  });
  // B2: a zero-amount marker (addon-cancel / addon-grant / addon-overlap) is not a newer plan payment
  it.each([
    'addon-cancel:feature:floating_widget',
    'addon-grant:feature:floating_widget',
    'addon-overlap:ai:topup_300',
  ])('a full plan refund still ends plan access after an add-on marker row (%s)', async marker => {
    refundTx.billingEvent.findUnique.mockImplementation(async ({ where }: any) =>
      where.id === 'c1'
        ? { ...charge('growth'), type: 'renewal', createdAt: new Date('2026-11-01') }
        : { id: where.id, relatedEventId: 'c1', storeId: 's1' }
    );
    refundTx.storeSubscription.findUnique.mockResolvedValue({
      planCode: 'growth',
      status: 'active',
    });
    const orig = refundTx.billingEvent.findMany;
    refundTx.billingEvent.findMany = async () => [{ id: 'm1', type: 'upgrade', planCode: marker }];
    try {
      await refundCharge({ eventId: 'c1', provider });
    } finally {
      refundTx.billingEvent.findMany = orig;
      refundTx.storeSubscription.findUnique.mockResolvedValue(null);
    }
    expect(refundTx.storeSubscription.update).toHaveBeenCalled();
  });
});
