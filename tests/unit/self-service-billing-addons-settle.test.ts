/**
 * SELF-SERVICE A8/A9 through the REAL settlement path (`settleInTx`): a succeeded payment grants its term exactly
 * once even when the same delivery arrives again, a failed payment grants nothing, and a failing grant write
 * surfaces (so the payment transaction rolls back and the gateway redelivers).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@api/lib/definer', () => ({
  getEntityStoreId: vi.fn(),
  getBillingRefundStoreId: vi.fn(),
}));
vi.mock('@api/services/platform/billing-d1', async () => {
  const real = await vi.importActual<Record<string, unknown>>('@api/services/platform/billing-d1');
  return { ...real, onD1: async () => false };
});
vi.mock('@ebda/database', () => ({
  prisma: {},
  withStore: vi.fn(),
  acrossStores: vi.fn(),
  storeDirectory: vi.fn(),
  currentStoreId: () => 's1',
}));
vi.mock('@api/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { settleInTx } from '@api/services/billing/subscription-billing.service';

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
    storeFeature: { deleteMany: async () => ({ count: 0 }) },
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
