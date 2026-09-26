/**
 * Loyalty refund reversals: the balance write must be computed from the row
 * it overwrites (#1427), and the duplicate-reversal backstops must be real
 * (#1426).
 *
 * #1427 — `reverseEarnedPointsFromOrder` read the customer's loyalty row with a
 * plain findUnique OUTSIDE its transaction and wrote ABSOLUTE `points` /
 * `totalEarned` inside it. A concurrent earn on the same customer landing
 * between the two was overwritten: 100 points, the reversal computes 50,
 * another order's delivery lifts the row to 130, the reversal stamps 50 — 30
 * points destroyed. `reverseRedeemedPointsFromOrder` had the same shape for
 * `totalRedeemed`. Both now lock the row, then read and write inside one
 * transaction. The mock below models the race: the pre-transaction read sees
 * the stale snapshot, the in-transaction read (after the lock) sees the row a
 * concurrent writer has since committed.
 *
 * #1426 — both reversals catch P2002 from the partial unique index on their
 * tagged `adjust` rows as a no-op. No test exercised either catch, so deleting
 * one left the suite green. Registered in docs/security/defence-mutations.json.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

class PrismaClientKnownRequestError extends Error {
  code: string;
  constructor(message: string, opts: { code: string }) {
    super(message);
    this.code = opts.code;
  }
}

const STORE = 'store-1';
const ORDER = 'order-1';
const CUSTOMER = 'cust-1';

// Outside-the-transaction reads (the fast paths and any stale snapshot).
const outerTxFindFirst = vi.fn();
const outerPointsFindUnique = vi.fn();
// Inside-the-transaction client.
const inTxFindFirst = vi.fn();
const inTxPointsFindUnique = vi.fn();
const inTxPointsUpdate = vi.fn();
const inTxCreate = vi.fn();
const inTxQueryRaw = vi.fn();
const order: string[] = [];

const txClient = {
  $queryRaw: (...a: unknown[]) => {
    order.push('lock');
    return inTxQueryRaw(...a);
  },
  loyaltyTransaction: {
    findFirst: (...a: unknown[]) => inTxFindFirst(...a),
    create: (...a: unknown[]) => inTxCreate(...a),
  },
  loyaltyPoints: {
    findUnique: (...a: unknown[]) => {
      order.push('read');
      return inTxPointsFindUnique(...a);
    },
    update: (...a: unknown[]) => inTxPointsUpdate(...a),
  },
};

vi.mock('@force/database', () => ({
  prisma: {
    loyaltyTransaction: {
      findFirst: (...a: unknown[]) => outerTxFindFirst(...a),
      // The pre-fix code built its batch from these; they must look like the
      // in-transaction writes so a reverted fix is judged on its VALUES.
      create: (...a: unknown[]) => inTxCreate(...a),
    },
    loyaltyPoints: {
      findUnique: (...a: unknown[]) => outerPointsFindUnique(...a),
      update: (...a: unknown[]) => inTxPointsUpdate(...a),
    },
    store: { findUnique: vi.fn(() => Promise.resolve({ loyaltySettings: {} })) },
    // Pre-fix array batch: run the already-created promises.
    $transaction: (arg: unknown) =>
      Array.isArray(arg) ? Promise.all(arg) : (arg as (tx: unknown) => unknown)(txClient),
  },
  withMoneyTx: (_client: unknown, fn: (tx: unknown) => unknown) => fn(txClient),
  Prisma: { PrismaClientKnownRequestError },
}));

vi.mock('@api/services/feature.service', () => ({
  featureService: { isFeatureEnabled: () => Promise.resolve(true) },
}));
vi.mock('@api/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { LoyaltyService } = await import('@api/services/loyalty.service');

const EARN = { id: 'earn-1', points: 50, customerId: CUSTOMER };
const REDEEM = { id: 'redeem-1', points: -500, customerId: CUSTOMER };

function row(points: number, totalEarned: number, totalRedeemed = 0) {
  return { id: 'lp-1', points, totalEarned, totalRedeemed, tier: 'bronze' };
}

beforeEach(() => {
  vi.clearAllMocks();
  order.length = 0;
  inTxQueryRaw.mockResolvedValue([{ id: 'lp-1' }]);
  inTxFindFirst.mockResolvedValue(null);
  inTxCreate.mockResolvedValue({});
  inTxPointsUpdate.mockImplementation((args: { data: { points: unknown } }) =>
    Promise.resolve({ points: typeof args.data.points === 'number' ? args.data.points : 0 })
  );
});

describe('reverseEarnedPointsFromOrder — no lost update against a concurrent earn (#1427)', () => {
  beforeEach(() => {
    outerTxFindFirst.mockImplementation((args: { where: { type?: string } }) =>
      Promise.resolve(args.where.type === 'earn_purchase' ? EARN : null)
    );
    // Stale snapshot a pre-transaction read would see …
    outerPointsFindUnique.mockResolvedValue(row(100, 100));
    // … and the row as it stands once the lock is held: another order's
    // delivery credited +30 in between.
    inTxPointsFindUnique.mockResolvedValue(row(130, 130));
  });

  it('computes the write from the locked row, keeping the concurrent +30', async () => {
    const res = await LoyaltyService.reverseEarnedPointsFromOrder(STORE, ORDER);

    expect(inTxPointsUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ points: 80, totalEarned: 80 }),
      })
    );
    expect(res).toEqual({ pointsReversed: 50, newBalance: 80 });
  });

  it('takes the row lock BEFORE reading the balance it writes back', async () => {
    await LoyaltyService.reverseEarnedPointsFromOrder(STORE, ORDER);

    expect(order.slice(0, 2)).toEqual(['lock', 'read']);
  });

  it('a same-order reversal that committed while we waited is a no-op under the lock', async () => {
    inTxFindFirst.mockResolvedValue({ id: 'adj-1' });

    const res = await LoyaltyService.reverseEarnedPointsFromOrder(STORE, ORDER);

    expect(res).toEqual({ pointsReversed: 0, newBalance: 130 });
    expect(inTxPointsUpdate).not.toHaveBeenCalled();
  });
});

describe('reverseRedeemedPointsFromOrder — totalRedeemed from the locked row (#1427)', () => {
  beforeEach(() => {
    outerTxFindFirst.mockImplementation((args: { where: { type?: string } }) =>
      Promise.resolve(args.where.type === 'redeem_discount' ? REDEEM : null)
    );
    outerPointsFindUnique.mockResolvedValue(row(0, 1000, 500));
    // A concurrent checkout redeemed 700 more in between.
    inTxPointsFindUnique.mockResolvedValue(row(0, 1000, 1200));
  });

  it('keeps the concurrent redemption in totalRedeemed', async () => {
    await LoyaltyService.reverseRedeemedPointsFromOrder(STORE, ORDER);

    expect(inTxPointsUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { points: { increment: 500 }, totalRedeemed: 700 },
      })
    );
    expect(order.slice(0, 2), 'row lock before the read it writes back').toEqual(['lock', 'read']);
  });
});

describe('duplicate-reversal backstops (#1426)', () => {
  const p2002 = () =>
    new PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002' });

  it('earn reversal: a P2002 from the tagged adjust insert is a no-op with the current balance', async () => {
    outerTxFindFirst.mockImplementation((args: { where: { type?: string } }) =>
      Promise.resolve(args.where.type === 'earn_purchase' ? EARN : null)
    );
    inTxPointsFindUnique.mockResolvedValue(row(130, 130));
    inTxCreate.mockRejectedValue(p2002());
    outerPointsFindUnique.mockResolvedValue({ points: 130 });

    await expect(LoyaltyService.reverseEarnedPointsFromOrder(STORE, ORDER)).resolves.toEqual({
      pointsReversed: 0,
      newBalance: 130,
    });
  });

  it('earn reversal: a non-P2002 failure is re-thrown, not swallowed', async () => {
    outerTxFindFirst.mockImplementation((args: { where: { type?: string } }) =>
      Promise.resolve(args.where.type === 'earn_purchase' ? EARN : null)
    );
    inTxPointsFindUnique.mockResolvedValue(row(130, 130));
    inTxCreate.mockRejectedValue(new PrismaClientKnownRequestError('boom', { code: 'P2003' }));

    await expect(LoyaltyService.reverseEarnedPointsFromOrder(STORE, ORDER)).rejects.toThrow('boom');
  });

  it('redeem re-credit: a P2002 from the tagged adjust insert is a no-op with the current balance', async () => {
    outerTxFindFirst.mockImplementation((args: { where: { type?: string } }) =>
      Promise.resolve(args.where.type === 'redeem_discount' ? REDEEM : null)
    );
    inTxPointsFindUnique.mockResolvedValue(row(40, 1000, 500));
    inTxCreate.mockRejectedValue(p2002());
    outerPointsFindUnique.mockResolvedValue({ points: 40 });

    await expect(LoyaltyService.reverseRedeemedPointsFromOrder(STORE, ORDER)).resolves.toEqual({
      pointsRecredited: 0,
      newBalance: 40,
    });
  });

  it('redeem re-credit: a non-P2002 failure is re-thrown, not swallowed', async () => {
    outerTxFindFirst.mockImplementation((args: { where: { type?: string } }) =>
      Promise.resolve(args.where.type === 'redeem_discount' ? REDEEM : null)
    );
    inTxPointsFindUnique.mockResolvedValue(row(40, 1000, 500));
    inTxCreate.mockRejectedValue(new PrismaClientKnownRequestError('boom', { code: 'P2003' }));

    await expect(LoyaltyService.reverseRedeemedPointsFromOrder(STORE, ORDER)).rejects.toThrow(
      'boom'
    );
  });
});
