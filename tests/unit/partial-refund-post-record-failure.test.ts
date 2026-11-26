/**
 * REFUND-988-REV-1 R2: ReturnService.adminPartialRefund must never reject a return whose refund is already RECORDED.
 * Rejecting frees its lines, so the same lines could be refunded and restocked a second time.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const returnFindFirst = vi.fn();
vi.mock('@ebda/database', () => ({
  prisma: { return: {}, order: {}, orderItem: {}, returnItem: {}, orderEvent: {}, payment: {} },
  Prisma: {},
  ReturnStatus: {},
  ReturnType: {},
}));
vi.mock('@api/lib/repo-factory', () => ({
  storeMoney: vi.fn().mockResolvedValue({
    analyticsRefundQuote: vi
      .fn()
      .mockResolvedValue({ refundable: 5000, coversWholeOrder: false, lines: [] }),
  }),
  storeDb: vi
    .fn()
    .mockResolvedValue({ return: { findFirst: (...a: unknown[]) => returnFindFirst(...a) } }),
}));
vi.mock('@api/services/payment-providers/payment.factory', () => ({
  PaymentService: {},
  findOutstandingRefundClaims: vi.fn(),
  reconcileOutstandingRefundClaims: vi.fn(),
}));
vi.mock('@api/services/order.service', () => ({ OrderService: {} }));
vi.mock('@api/services/feature.service', () => ({ featureService: { isFeatureEnabled: vi.fn() } }));
vi.mock('@api/services/email.service', () => ({ EmailService: {} }));
vi.mock('@api/services/socket.service', () => ({ socketService: { emitToStore: vi.fn() } }));
vi.mock('@api/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { ReturnService } from '@api/services/return.service';
import { AppError } from '@api/middleware/error-handler';

const DATA = {
  orderId: 'o1',
  reason: 'damaged',
  refundMethod: 'card',
  items: [{ orderItemId: 'i1', quantity: 1, restock: false }],
};

describe('adminPartialRefund after the refund is recorded', () => {
  let statusCalls: string[];
  beforeEach(() => {
    statusCalls = [];
    returnFindFirst.mockReset();
    vi.restoreAllMocks();
    vi.spyOn(ReturnService, 'adminCreate').mockResolvedValue({
      id: 'r1',
      status: 'pending',
    } as never);
    vi.spyOn(ReturnService, 'updateStatusOnDo').mockImplementation((async (...a: unknown[]) => {
      statusCalls.push(String(a[3]));
    }) as never);
    vi.spyOn(ReturnService, 'getById').mockResolvedValue({
      id: 'r1',
      status: 'completed',
    } as never);
  });

  it('completed row + effects enqueue failure: stays completed, flagged, NOT rejected', async () => {
    vi.spyOn(ReturnService, 'complete').mockRejectedValue(new Error('enqueue failed'));
    returnFindFirst.mockResolvedValue({ status: 'completed', refundedAt: new Date() });
    const r = (await ReturnService.adminPartialRefund('s1', 'u1', DATA, 'k1')) as any;
    expect(r.needsAttention).toBe(true);
    expect(statusCalls).not.toContain('rejected');
  });

  it('provider paid but finish failed (claim still held): not rejected, 502 do-not-refund-again', async () => {
    vi.spyOn(ReturnService, 'complete').mockRejectedValue(new Error('finish failed'));
    returnFindFirst.mockResolvedValue({ status: 'received', refundedAt: new Date() });
    await expect(ReturnService.adminPartialRefund('s1', 'u1', DATA, 'k1')).rejects.toMatchObject({
      code: 'PROVIDER_REFUND_INDETERMINATE',
    });
    expect(statusCalls).not.toContain('rejected');
  });

  it('state unreadable after a failure: never rejects', async () => {
    vi.spyOn(ReturnService, 'complete').mockRejectedValue(new Error('boom'));
    returnFindFirst.mockRejectedValue(new Error('db down'));
    await expect(ReturnService.adminPartialRefund('s1', 'u1', DATA, 'k1')).rejects.toBeInstanceOf(
      AppError
    );
    expect(statusCalls).not.toContain('rejected');
  });

  it('claim released (nothing recorded): still rejected so the lines can retry', async () => {
    const err = new AppError(502, 'PROVIDER_REFUND_FAILED', 'x');
    vi.spyOn(ReturnService, 'complete').mockRejectedValue(err);
    returnFindFirst.mockResolvedValue({ status: 'received', refundedAt: null });
    await expect(ReturnService.adminPartialRefund('s1', 'u1', DATA, 'k1')).rejects.toBe(err);
    expect(statusCalls).toContain('rejected');
  });
});
