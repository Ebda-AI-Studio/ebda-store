/**
 * #618 — processCommission / reverseCommission must not credit (or debit) an
 * affiliate twice when two duplicate Inngest deliveries both pass the
 * findFirst fast path. The guard is a conditional claim on the referral row:
 * the loser's updateMany matches 0 rows and the balance write never runs.
 *
 * #1589 / #1590 — the money audit row must be AWAITED, and written on the
 * same transaction client as the balance change. On the Inngest paths there is
 * no deferral scope, so a `void` call let processCommission return (and the tx
 * commit) before the insert finished; a deferred one was dropped on a 5xx.
 *
 * The real-Postgres race is in tests/integration/affiliate-commission-race.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('@api/lib/store-operational', () => ({
  STORE_NOT_OPERATIONAL: 'STORE_NOT_OPERATIONAL',
  isStoreOperational: (s: unknown) => s === 'active',
  storeOperational: async () => true,
  storeMayMessageCustomers: async () => true,
  assertStoreOperational: async () => undefined,
  activeStoreIds: async () => ({ has: () => true }) as unknown as Set<string>,
  requireOperationalStore: (_q: unknown, _r: unknown, next: () => void) => next(),
}));

const h = vi.hoisted(() => ({
  referralFindFirst: vi.fn(),
  referralUpdateMany: vi.fn(),
  affiliateUpdate: vi.fn(async () => ({})),
  orderFindUnique: vi.fn(async () => ({ id: 'order-1', total: 1000 })),
  configFindUnique: vi.fn(async () => null),
  recordAffiliateEvent: vi.fn(),
  affiliateEventCreate: vi.fn(),
  affiliateFindFirst: vi.fn(),
  affiliateUpdateMany: vi.fn(),
  payoutCreate: vi.fn(async ({ data }: { data: object }) => ({ id: 'payout-1', ...data })),
}));

vi.mock('@ebda/database', () => {
  const prisma = {
    affiliateReferral: { findFirst: h.referralFindFirst, updateMany: h.referralUpdateMany },
    affiliate: {
      update: h.affiliateUpdate,
      findFirst: h.affiliateFindFirst,
      updateMany: h.affiliateUpdateMany,
    },
    affiliatePayout: { create: h.payoutCreate },
    order: { findUnique: h.orderFindUnique },
    affiliateConfig: { findUnique: h.configFindUnique },
  };
  return {
    prisma,
    Prisma: {},
    hasTenantContext: vi.fn(() => true),
    withMoneyTx: vi.fn(),
  };
});
vi.mock('@api/services/affiliate-event.service', () => ({
  recordAffiliateEvent: h.recordAffiliateEvent,
  affiliateEventCreate: h.affiliateEventCreate,
}));
vi.mock('@api/services/redis.service', () => ({
  redis: { get: vi.fn(async () => null), set: vi.fn(), del: vi.fn() },
}));
vi.mock('@api/lib/logger', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { affiliateService } from '@api/services/affiliate.service';

const convertedReferral = {
  id: 'ref-1',
  affiliateId: 'aff-1',
  status: 'converted',
  commissionAmount: null,
  affiliate: { commissionRate: null },
};
const paidReferral = {
  id: 'ref-1',
  affiliateId: 'aff-1',
  status: 'commission_paid',
  commissionAmount: 100,
};

beforeEach(() => {
  vi.clearAllMocks();
  h.recordAffiliateEvent.mockResolvedValue(null);
  h.affiliateEventCreate.mockResolvedValue({ id: 'evt-1' });
});

describe('processCommission — duplicate delivery (#618)', () => {
  it('claims the referral conditionally before crediting the affiliate', async () => {
    h.referralFindFirst.mockResolvedValue(convertedReferral);
    h.referralUpdateMany.mockResolvedValue({ count: 1 });

    await expect(affiliateService.processCommission('s1', 'order-1')).resolves.toEqual({
      commissionAmount: 100,
      rate: 10,
    });
    expect(h.referralUpdateMany).toHaveBeenCalledWith({
      where: { id: 'ref-1', storeId: 's1', status: 'converted', commissionAmount: null },
      data: { commissionAmount: 100, status: 'commission_paid' },
    });
    expect(h.affiliateUpdate).toHaveBeenCalledTimes(1);
    // The audit row goes through the transaction client the credit ran on.
    expect(h.affiliateEventCreate).toHaveBeenCalledTimes(1);
    expect(h.affiliateEventCreate.mock.calls[0][0]).toMatchObject({
      eventType: 'commission_recorded',
    });
    expect(h.affiliateEventCreate.mock.calls[0][1]).toBeDefined();
  });

  it('does not credit the affiliate when a concurrent run already claimed the referral', async () => {
    h.referralFindFirst.mockResolvedValue(convertedReferral); // stale fast-path read
    h.referralUpdateMany.mockResolvedValue({ count: 0 }); // the winner committed first

    await expect(affiliateService.processCommission('s1', 'order-1')).resolves.toBeNull();
    expect(h.affiliateUpdate).not.toHaveBeenCalled();
    expect(h.recordAffiliateEvent).not.toHaveBeenCalled();
    expect(h.affiliateEventCreate).not.toHaveBeenCalled();
  });
});

describe('reverseCommission — duplicate delivery (#618)', () => {
  it('does not debit the affiliate twice', async () => {
    h.referralFindFirst.mockResolvedValue(paidReferral);
    h.referralUpdateMany.mockResolvedValue({ count: 0 });

    await expect(affiliateService.reverseCommission('s1', 'order-1')).resolves.toBeNull();
    expect(h.referralUpdateMany).toHaveBeenCalledWith({
      where: { id: 'ref-1', storeId: 's1', status: 'commission_paid' },
      data: { status: 'refunded' },
    });
    expect(h.affiliateUpdate).not.toHaveBeenCalled();
  });

  it('debits once when it wins the claim (control)', async () => {
    h.referralFindFirst.mockResolvedValue(paidReferral);
    h.referralUpdateMany.mockResolvedValue({ count: 1 });

    await expect(affiliateService.reverseCommission('s1', 'order-1')).resolves.toEqual({
      amount: 100,
    });
    expect(h.affiliateUpdate).toHaveBeenCalledWith({
      where: { id: 'aff-1', storeId: 's1' },
      data: { totalEarned: { decrement: 100 }, pendingBalance: { decrement: 100 } },
    });
  });
});

describe('commission audit rows are awaited (#1589)', () => {
  function slowAuditWrite() {
    const state = { written: false };
    h.affiliateEventCreate.mockImplementation(
      () =>
        new Promise(resolve =>
          setTimeout(() => {
            state.written = true;
            resolve({ id: 'evt-1' });
          }, 5)
        )
    );
    return state;
  }

  it('processCommission does not return before commission_recorded is written', async () => {
    h.referralFindFirst.mockResolvedValue(convertedReferral);
    h.referralUpdateMany.mockResolvedValue({ count: 1 });
    const audit = slowAuditWrite();

    await affiliateService.processCommission('s1', 'order-1');
    expect(audit.written).toBe(true);
  });

  it('reverseCommission does not return before commission_reversed is written', async () => {
    h.referralFindFirst.mockResolvedValue(paidReferral);
    h.referralUpdateMany.mockResolvedValue({ count: 1 });
    const audit = slowAuditWrite();

    await affiliateService.reverseCommission('s1', 'order-1');
    expect(audit.written).toBe(true);
  });
});

describe('createPayout — concurrent payouts cannot overdraw the balance', () => {
  it('debits the balance conditionally and refuses when a concurrent payout already took it', async () => {
    // The read says 5.000 EGP is pending — but a concurrent payout committed
    // first, so the conditional debit matches 0 rows.
    h.affiliateFindFirst.mockResolvedValue({ id: 'aff-1', pendingBalance: 5000 });
    h.affiliateUpdateMany.mockResolvedValue({ count: 0 });

    await expect(
      affiliateService.createPayout('s1', 'aff-1', { amount: 4000 })
    ).rejects.toMatchObject({ statusCode: 400, code: 'INSUFFICIENT_BALANCE' });
    expect(h.affiliateUpdateMany).toHaveBeenCalledWith({
      where: { id: 'aff-1', storeId: 's1', pendingBalance: { gte: 4000 } },
      data: { pendingBalance: { decrement: 4000 }, totalPaid: { increment: 4000 } },
    });
    expect(h.payoutCreate).not.toHaveBeenCalled();
    expect(h.affiliateEventCreate).not.toHaveBeenCalled();
  });

  it('creates the payout when the debit succeeds (control)', async () => {
    h.affiliateFindFirst.mockResolvedValue({ id: 'aff-1', pendingBalance: 5000 });
    h.affiliateUpdateMany.mockResolvedValue({ count: 1 });

    const payout = await affiliateService.createPayout('s1', 'aff-1', { amount: 4000 });
    expect(payout).toMatchObject({ amount: 4000 });
    // The audit row, in the same transaction, names the payout it created.
    expect(h.affiliateEventCreate).toHaveBeenCalledTimes(1);
    expect(h.affiliateEventCreate.mock.calls[0][0]).toMatchObject({
      eventType: 'payout_initiated',
      details: { payoutId: payout.id, amount: 4000 },
    });
  });
});
