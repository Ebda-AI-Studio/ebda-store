/**
 * Follow-up to #788 (review): (1) the add-on grant giving up after its chain tries raises a P1 naming the billing event;
 * (2) the ledger claim `claimEvent` (renewal, checkout, upgrade) is ONE native statement on the platform D1, never a
 * prisma-lite createMany count, which can end with zero winners (no charge, no retry, no notice).
 * Deterministic: no timing, the fakes decide every outcome.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  onD1: true,
  native: vi.fn(),
  createMany: vi.fn(),
  alert: vi.fn(async () => undefined),
}));

vi.mock('@api/services/platform/billing-d1', async () => {
  const real = await vi.importActual<Record<string, unknown>>('@api/services/platform/billing-d1');
  return {
    ...real,
    onD1: async () => h.onD1,
    claimBillingEventD1: h.native,
    claimAddonMarkerD1: async () => false,
    setTermEndOnceD1: async () => false,
  };
});
vi.mock('@api/services/alerts.service', () => ({ sendAlert: h.alert }));
vi.mock('@api/lib/definer', () => ({
  getEntityStoreId: vi.fn(),
  getBillingRefundStoreId: vi.fn(),
}));
vi.mock('@api/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@ebda/database', () => ({
  prisma: {},
  withStore: async (_id: string, fn: (t: unknown) => unknown) =>
    fn({ billingEvent: { createMany: h.createMany } }),
  acrossStores: vi.fn(),
  storeDirectory: vi.fn(),
  currentStoreId: () => 's1',
}));

import { claimEvent } from '@api/services/billing/subscription-billing.service';
import { applyAddonGrant } from '@api/services/billing/addon-grant';

const input = {
  storeId: 's1',
  type: 'upgrade' as const,
  planCode: 'addon:feature:floating_widget',
  amountMinor: 9900,
  provider: 'kashier',
  idempotencyKey: 'addon-renew:s1:feature:floating_widget:2027-01-01',
};

beforeEach(() => {
  vi.clearAllMocks();
  h.onD1 = true;
  h.createMany.mockResolvedValue({ count: 1 });
});

describe('claimEvent on the platform D1 is a native single statement', () => {
  it('the winner of the native claim gets the id, the loser gets null, and createMany is never used', async () => {
    h.native.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const a = await claimEvent(input);
    const b = await claimEvent(input);
    expect(typeof a).toBe('string');
    expect(b).toBeNull();
    expect(h.createMany).not.toHaveBeenCalled();
    expect(h.native.mock.calls[0][0]).toMatchObject({
      storeId: 's1',
      type: 'upgrade',
      amountMinor: 9900,
      idempotencyKey: input.idempotencyKey,
    });
  });
  it('B3: the claim stores `raw` (a refund keepAccess) so a webhook settle reads the same choice', async () => {
    h.native.mockResolvedValueOnce(true);
    await claimEvent({ ...input, raw: { keepAccess: true } });
    expect(h.native.mock.calls[0][0]).toMatchObject({ raw: { keepAccess: true } });
  });
  it('on Postgres the claim is still createMany + skipDuplicates', async () => {
    h.onD1 = false;
    expect(typeof (await claimEvent(input))).toBe('string');
    expect(h.createMany).toHaveBeenCalledTimes(1);
    expect(h.native).not.toHaveBeenCalled();
  });
});

describe('the add-on chain giving up is loud', () => {
  it('raises a P1 that names the billing event, then throws so the gateway redelivers', async () => {
    h.onD1 = false;
    let n = 0;
    // every slot is held by a DIFFERENT payment: the loop can only run out of tries
    const tx: any = {
      storeFeature: { findFirst: async () => null },
      billingEvent: {
        findFirst: vi.fn(async ({ where }: any) =>
          where.idempotencyKey
            ? {
                relatedEventId: `other-${++n}`,
                forPeriodEnd: new Date(Date.now() + n * 86_400_000),
              }
            : null
        ),
        createMany: async () => ({ count: 0 }),
        updateMany: async () => ({ count: 0 }),
      },
    };
    await expect(
      applyAddonGrant(
        tx,
        { id: 'pay-1', storeId: 's1', planCode: input.planCode } as any,
        new Date(),
        []
      )
    ).rejects.toThrow(/ADDON_GRANT_CHAIN_CONTENDED/);
    expect(h.alert).toHaveBeenCalledWith(
      expect.objectContaining({ level: 'p1', body: expect.stringContaining('pay-1') })
    );
  });
});

describe('B4: dead anchors never spend the retry budget', () => {
  it.each(['refunded', 'failed'])(
    'a purchase placed after 8 %s markers under one predecessor still grants',
    async dead => {
      h.onD1 = false;
      const DEAD = 8; // more than CHAIN_TRIES (6)
      const base = 'addon-after:s1:feature:floating_widget:none';
      const held: Record<string, { relatedEventId: string; forPeriodEnd: Date }> = {};
      for (let g = 0; g < DEAD; g++)
        held[g === 0 ? base : `${base}:r${g}`] = {
          relatedEventId: `dead-${g}`,
          forPeriodEnd: new Date(Date.now() + 30 * 86_400_000),
        };
      const created: string[] = [];
      const tx: any = {
        storeFeature: { findFirst: async () => null },
        billingEvent: {
          findFirst: vi.fn(async ({ where }: any) => {
            if (where.idempotencyKey) return held[where.idempotencyKey] ?? null;
            if (where.id) return { status: dead, failureReason: null, updatedAt: null }; // every held payment is dead
            return null; // no own marker, no latest predecessor
          }),
          createMany: async ({ data }: any) => {
            const k = data[0].idempotencyKey;
            if (held[k]) return { count: 0 };
            created.push(k);
            return { count: 1 };
          },
          updateMany: vi.fn(async () => ({ count: 1 })),
        },
      };
      const effects: any[] = [];
      await applyAddonGrant(
        tx,
        { id: 'pay-9', storeId: 's1', planCode: input.planCode } as any,
        new Date(),
        effects
      );
      expect(created).toEqual([`${base}:r${DEAD}`]);
      expect(effects).toEqual([{ kind: 'addon_granted', storeId: 's1' }]);
      expect(h.alert).not.toHaveBeenCalled();
    }
  );
});
