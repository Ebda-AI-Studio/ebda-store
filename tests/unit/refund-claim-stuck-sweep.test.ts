/**
 * The stuck refund-claim check (#1317).
 *
 * PaymentService.refund commits a claim (`refund_initiated`) before calling the
 * provider and resolves it with `refund_completed` or `refund_failed`. A claim
 * with neither means the balance counts money that may never have left — a
 * process died mid-refund, or the provider never answered. Only an old,
 * unresolved claim may be raised; a resolved or still-running one must not.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockEventFindMany, mockSendAlert } = vi.hoisted(() => ({
  mockEventFindMany: vi.fn(),
  mockSendAlert: vi.fn(),
}));

vi.mock('@force/database', () => ({
  withRlsBypass: (fn: (tx: unknown) => unknown) =>
    fn({ paymentEvent: { findMany: mockEventFindMany } }),
}));
vi.mock('@api/services/alerts.service', () => ({ sendAlert: mockSendAlert }));
vi.mock('@api/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { handleStuckRefundClaimSweep } from '@api/lib/inngest/functions/refund-claim-stuck-sweep';

const stepStub = { run: async <T>(_id: string, fn: () => Promise<T>): Promise<T> => fn() };
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);

function event(eventType: string, claimId: string, at: Date) {
  return {
    eventType,
    paymentId: 'pay-1',
    storeId: 'store-1',
    orderId: 'order-1',
    details: { claimId, amount: 2000, reason: 'x' },
    occurredAt: at,
  };
}

describe('handleStuckRefundClaimSweep', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSendAlert.mockResolvedValue('sent');
  });

  it('raises a claim that was never confirmed or released', async () => {
    mockEventFindMany.mockResolvedValue([event('refund_initiated', 'c1', minutesAgo(60))]);

    const res = await handleStuckRefundClaimSweep(stepStub);

    expect(res.stuck).toBe(1);
    expect(mockSendAlert).toHaveBeenCalledOnce();
    expect(mockSendAlert.mock.calls[0][0].source).toBe('payment.refund.claim_stuck');
  });

  it('an indeterminate outcome is still unresolved', async () => {
    mockEventFindMany.mockResolvedValue([
      event('refund_initiated', 'c1', minutesAgo(60)),
      // Not in the query's set, but harmless if it ever is: it resolves nothing.
      event('refund_indeterminate', 'c1', minutesAgo(59)),
    ]);

    expect((await handleStuckRefundClaimSweep(stepStub)).stuck).toBe(1);
  });

  it.each(['refund_completed', 'refund_failed'])(
    'a claim resolved by %s is not raised',
    async t => {
      mockEventFindMany.mockResolvedValue([
        event('refund_initiated', 'c1', minutesAgo(60)),
        event(t, 'c1', minutesAgo(59)),
      ]);

      const res = await handleStuckRefundClaimSweep(stepStub);

      expect(res.stuck).toBe(0);
      expect(mockSendAlert).not.toHaveBeenCalled();
    }
  );

  it('a claim still inside its request window is not raised', async () => {
    mockEventFindMany.mockResolvedValue([event('refund_initiated', 'c1', minutesAgo(1))]);

    expect((await handleStuckRefundClaimSweep(stepStub)).stuck).toBe(0);
    expect(mockSendAlert).not.toHaveBeenCalled();
  });

  it('only reads refund-ledger events, and only recent ones', async () => {
    mockEventFindMany.mockResolvedValue([]);

    await handleStuckRefundClaimSweep(stepStub);

    const where = mockEventFindMany.mock.calls[0][0].where;
    expect(where.eventType).toEqual({
      in: ['refund_initiated', 'refund_completed', 'refund_failed'],
    });
    expect(where.occurredAt.gt).toBeInstanceOf(Date);
  });
});
