/**
 * A revoked earn must STAY revoked. Do not re-credit on "a revoke is
 * outstanding".
 *
 * This file exists because that fix was written, reviewed and nearly shipped.
 * The reasoning was: reversing an earn leaves the `earn_purchase` row in place
 * (it is the audit record, and the partial unique index forbids a second one),
 * so `earnPointsFromPurchase` treats the order as already credited and a
 * re-delivered refunded order never gets its points back. True as far as it
 * goes — and useless, because the premise is unreachable and the mechanism is
 * harmful:
 *
 *  1. There is NO refunded → delivered path. `VALID_ORDER_TRANSITIONS` has
 *     `refunded: []`, and `assertValidTransition` guards every `Order.status`
 *     writer. An order cannot be re-delivered after a refund, so the scenario
 *     the re-credit was built for cannot occur in production.
 *
 *  2. What DOES occur is the inverse. `applyRefundEffects` runs on orders that
 *     stay `delivered` — a partial return (return.service.ts) and a backorder
 *     cancel (accounting/backorder.service.ts) both call it without moving the
 *     status — and the `order/refunded` fanout then calls
 *     `reverseEarnedPointsFromOrder`, which revokes the WHOLE earn.
 *
 *  3. `assertValidTransition` returns early when `from === to`, so a merchant
 *     re-selecting "Delivered" on that same order is a legal write and still
 *     emits `order/status-changed`; the fanout has no per-order dedupe marker.
 *
 * Put together: return one item → all points correctly revoked → merchant
 * re-selects Delivered (or any re-emission / inline-fallback replay fires) →
 * a re-credit keyed on "revokes > recredits" hands every point back and
 * silently undoes the refund's clawback. That is the ONLY way such a branch is
 * reachable at all.
 *
 * So the `alreadyEarned` short-circuit is not an oversight — it is the guard.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const txFindFirst = vi.fn();
const txFindMany = vi.fn(() => Promise.resolve([]));
const txCreate = vi.fn();
const pointsUpdate = vi.fn();
const pointsFindUnique = vi.fn();
const transaction = vi.fn();

vi.mock('@ebda/database', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mod: Record<string, any> = {
    prisma: {
      loyaltyTransaction: {
        findFirst: (...a: unknown[]) => txFindFirst(...a),
        findMany: (...a: unknown[]) => txFindMany(...a),
        create: (...a: unknown[]) => txCreate(...a),
      },
      loyaltyPoints: {
        update: (...a: unknown[]) => pointsUpdate(...a),
        findUnique: (...a: unknown[]) => pointsFindUnique(...a),
        upsert: vi.fn(),
      },
      store: { findUnique: vi.fn(() => Promise.resolve({ loyaltySettings: {} })) },
      $transaction: (...a: unknown[]) => transaction(...a),
    },
    Prisma: {
      PrismaClientKnownRequestError: class extends Error {
        code = 'P2002';
      },
    },
  };
  mod.withStore = (_id: string, fn: (tx: unknown) => unknown) => fn(mod.prisma);
  return mod;
});

vi.mock('@api/services/feature.service', () => ({
  featureService: { isFeatureEnabled: () => Promise.resolve(true) },
}));
vi.mock('@api/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { LoyaltyService } = await import('@api/services/loyalty.service');

const STORE = 'store-1';
const ORDER = 'order-1';
const CUSTOMER = 'cust-1';

describe('a revoked earn stays revoked', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    txFindMany.mockResolvedValue([]);
    pointsFindUnique.mockResolvedValue({ points: 0 });
    pointsUpdate.mockResolvedValue({ points: 0 });
    transaction.mockResolvedValue([{ points: 0 }, {}]);
  });

  it('does not credit again when an earn row already exists', async () => {
    // The row survives a refund reversal by design, so its presence is the
    // guard against re-crediting — not a bug to be worked around.
    txFindFirst.mockImplementation((args: { where: { type?: string } }) =>
      Promise.resolve(
        args.where.type === 'earn_purchase'
          ? { id: 'earn-1', points: 120, customerId: CUSTOMER }
          : null
      )
    );

    const res = await LoyaltyService.earnPointsFromPurchase(STORE, CUSTOMER, ORDER, 5000);

    expect(res.pointsEarned, 'a re-emitted delivered event must not re-credit').toBe(0);
    expect(pointsUpdate, 'no balance write at all').not.toHaveBeenCalled();
  });

  it('does not credit again even when the earn was reversed by a refund', async () => {
    // The state after a partial return: earn row present, a compensating
    // `adjust` row alongside it, order still `delivered`. A re-selected
    // "Delivered" must NOT hand the points back — doing so undoes the
    // clawback the refund performed.
    txFindFirst.mockImplementation((args: { where: { type?: string } }) =>
      Promise.resolve(
        args.where.type === 'earn_purchase'
          ? { id: 'earn-1', points: 120, customerId: CUSTOMER }
          : { id: 'adj-1', description: 'refund-revoke:earn-1' }
      )
    );
    txFindMany.mockResolvedValue([{ id: 'adj-1', description: 'refund-revoke:earn-1' }]);

    const res = await LoyaltyService.earnPointsFromPurchase(STORE, CUSTOMER, ORDER, 5000);

    expect(
      res.pointsEarned,
      'an outstanding revoke is NOT evidence of a re-delivery — refunded is terminal'
    ).toBe(0);
    expect(pointsUpdate).not.toHaveBeenCalled();
    expect(txCreate, 'no compensating credit row either').not.toHaveBeenCalled();
  });

  it('still credits a first-time earn (the guard is not blanket)', async () => {
    txFindFirst.mockResolvedValue(null);
    pointsFindUnique.mockResolvedValue({ points: 0, tier: 'bronze', totalEarned: 0 });

    const res = await LoyaltyService.earnPointsFromPurchase(STORE, CUSTOMER, ORDER, 5000);

    // The credit path ran AND credited the right amount. Reaching the
    // transaction alone is not enough: with orderId/orderTotalFils swapped
    // (#1444) this test used to credit NaN points and still pass.
    // 5000 piastres = 50 EGP × 1 point/EGP (default) × 1.0 bronze multiplier = 50.
    expect(transaction).toHaveBeenCalled();
    expect(res.pointsEarned).toBe(50);
    expect(pointsUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ points: { increment: 50 } }),
      })
    );
    expect(txCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ orderId: ORDER, type: 'earn_purchase', points: 50 }),
      })
    );
  });
});
