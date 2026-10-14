/**
 * LoyaltyService.earnPointsFromPurchase — idempotency guard.
 *
 * Two separate `order/status-changed` events for the same delivered transition
 * (admin double-click, or updateStatus called twice) spawn independent Inngest
 * runs. Without a per-order guard each would credit points again. Two guards:
 *
 * 1. Fast path: a matching `earn_purchase` loyaltyTransaction for the order
 *    already exists (findFirst) → no-op, no transaction attempted.
 * 2. DB-level guarantee (closes the #528 follow-up race): the fanout runs
 *    `concurrency: limit 5` per store, so two concurrent calls for the same
 *    order can both pass the findFirst before either commits. A partial
 *    unique index on (store_id, order_id) WHERE type='earn_purchase' (see
 *    migration 20260711120000_loyalty_earn_unique) makes the loser's insert
 *    fail with P2002 — caught and treated as a no-op too, not an unhandled
 *    throw. Because the increment + insert are one $transaction, Postgres
 *    rolls back the WHOLE transaction on the P2002, so the points balance
 *    is never double-incremented.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  storeFindUnique: vi.fn(),
  isFeatureEnabled: vi.fn(),
  lpFindUnique: vi.fn(),
  lpCreate: vi.fn(),
  ltFindFirst: vi.fn(),
  ltCreate: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock('@ebda/database', () => {
  // Minimal stand-in for Prisma's real PrismaClientKnownRequestError so the
  // source's `err instanceof Prisma.PrismaClientKnownRequestError` check
  // works against errors constructed via this same mocked `Prisma` export.
  class PrismaClientKnownRequestError extends Error {
    code: string;
    constructor(message: string, opts: { code: string }) {
      super(message);
      this.code = opts.code;
    }
  }

  const prisma = {
    store: { findUnique: h.storeFindUnique },
    loyaltyPoints: { findUnique: h.lpFindUnique, create: h.lpCreate, update: vi.fn() },
    loyaltyTransaction: { findFirst: h.ltFindFirst, create: h.ltCreate },
    $transaction: h.transaction,
  };
  return {
    prisma,
    withStore: (_id: string, fn: (tx: unknown) => unknown) => fn(prisma),
    Prisma: { PrismaClientKnownRequestError },
  };
});
vi.mock('@api/services/feature.service', () => ({
  featureService: { isFeatureEnabled: h.isFeatureEnabled },
}));

import { Prisma } from '@ebda/database';
import { LoyaltyService } from '@api/services/loyalty.service';

beforeEach(() => {
  vi.clearAllMocks();
  h.storeFindUnique.mockResolvedValue({ loyaltySettings: {} });
  h.isFeatureEnabled.mockResolvedValue(true);
  h.lpFindUnique.mockResolvedValue({
    id: 'lp1',
    points: 120,
    totalEarned: 300,
    tier: 'bronze',
  });
  h.transaction.mockResolvedValue([{ points: 125 }, {}]);
});

describe('earnPointsFromPurchase idempotency', () => {
  it('no-ops (no credit) when the order was already awarded points', async () => {
    h.ltFindFirst.mockResolvedValue({ id: 'existing-earn' });
    const r = await LoyaltyService.earnPointsFromPurchase('s1', 'c1', 'o1', 5000);
    expect(r.pointsEarned).toBe(0);
    expect(r.newBalance).toBe(120); // current balance, unchanged
    expect(h.transaction).not.toHaveBeenCalled(); // never credits twice
  });

  it('credits points when the order has no prior earn transaction', async () => {
    h.ltFindFirst.mockResolvedValue(null);
    const r = await LoyaltyService.earnPointsFromPurchase('s1', 'c1', 'o1', 5000);
    expect(h.transaction).toHaveBeenCalledTimes(1);
    expect(r.pointsEarned).toBeGreaterThan(0);
  });

  it('no-ops (no throw, no double-award) when the transaction hits P2002 on the concurrent-race window', async () => {
    // findFirst fast-path misses (this call "won" the read), but a concurrent
    // sibling call already committed its insert by the time this one tries
    // to write — the partial unique index rejects it with P2002.
    h.ltFindFirst.mockResolvedValue(null);
    h.transaction.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002' })
    );

    const r = await LoyaltyService.earnPointsFromPurchase('s1', 'c1', 'o1', 5000);

    expect(r.pointsEarned).toBe(0);
    expect(r.newBalance).toBe(120); // re-read current balance, not double-incremented
    expect(h.transaction).toHaveBeenCalledTimes(1);
  });

  it('re-throws a non-P2002 error from the transaction', async () => {
    h.ltFindFirst.mockResolvedValue(null);
    h.transaction.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('Foreign key violation', { code: 'P2003' })
    );

    await expect(LoyaltyService.earnPointsFromPurchase('s1', 'c1', 'o1', 5000)).rejects.toThrow(
      'Foreign key violation'
    );
  });
});
