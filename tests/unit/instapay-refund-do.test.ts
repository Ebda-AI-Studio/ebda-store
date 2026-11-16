/**
 * InstapayService.recordRefund on a store on its Durable Object (Ruling NZ-MONEY-6): the partial-failure contract of the
 * resumable two-step flow (one DO money op, then the order status flip).
 *   - a committed record keeps its screenshot even when the status flip fails (the record points at it);
 *   - an UNcommitted record (the DO refused) frees its screenshot;
 *   - a replay frees ITS screenshot (unreferenced) and, for a full refund on an order not yet `refunded`, runs the flip
 *     again, so the order converges.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  money: { instapayRefundRecord: vi.fn() },
  putPrivate: vi.fn(async () => ({ key: 'instapay-refunds/shot.png' })),
  deletePrivate: vi.fn(async () => undefined),
  updateStatus: vi.fn(async () => undefined),
  recordRefundOutsideReturn: vi.fn(async () => undefined),
}));

vi.mock('@api/lib/repo-factory', () => ({
  storeMoney: async () => h.money,
  storeDb: async () => ({}),
}));
vi.mock('@api/services/storage.service', () => ({
  StorageService: { putPrivate: h.putPrivate, deletePrivate: h.deletePrivate },
}));
vi.mock('@api/services/order.service', () => ({
  OrderService: {
    updateStatus: h.updateStatus,
    recordRefundOutsideReturn: h.recordRefundOutsideReturn,
  },
}));
vi.mock('@api/services/payment-providers/instapay-receipt.service', () => ({
  InstapayReceiptService: {},
  sniffReceiptMime: () => 'image/png',
  toReceiptView: () => ({}),
}));
vi.mock('@api/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { InstapayService } from '@api/services/payment-providers/instapay.service';

const input = {
  reference: '11112222',
  refundDate: '2026-11-10',
  refundTime: '12:00',
  recipientName: 'N*** B***',
  amountMinor: 9000,
};
const call = () =>
  InstapayService.recordRefund({
    storeId: 's1',
    orderId: 'o1',
    input,
    screenshot: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    actorUserId: 'm1',
    now: new Date('2026-11-11T00:00:00Z'),
  });
const answer = (over: Record<string, unknown>) => ({
  duplicate: false,
  full: true,
  paymentId: 'p1',
  fromStatus: 'completed',
  status: 'refunded',
  refundedAmount: 9000,
  orderStatus: 'confirmed',
  ...over,
});

describe('InstapayService.recordRefund on a DO store', () => {
  beforeEach(() => vi.clearAllMocks());

  it('a full refund records once, then flips the order to refunded', async () => {
    h.money.instapayRefundRecord.mockResolvedValueOnce(answer({}));
    await expect(call()).resolves.toMatchObject({ duplicate: false, status: 'refunded' });
    expect(h.money.instapayRefundRecord).toHaveBeenCalledWith(
      expect.objectContaining({ orderId: 'o1', referenceKey: '11112222', amountMinor: 9000 })
    );
    expect(h.updateStatus).toHaveBeenCalledWith('s1', 'o1', 'refunded');
    expect(h.deletePrivate).not.toHaveBeenCalled();
  });

  it('the status flip fails AFTER the record committed: the screenshot is kept and the error surfaces', async () => {
    h.money.instapayRefundRecord.mockResolvedValueOnce(answer({}));
    h.updateStatus.mockRejectedValueOnce(new Error('fanout down'));
    await expect(call()).rejects.toThrow('fanout down');
    expect(h.deletePrivate).not.toHaveBeenCalled();
  });

  it('the retry is a replay: its own screenshot is freed and the order flip runs again (forward completion)', async () => {
    h.money.instapayRefundRecord.mockResolvedValueOnce(answer({ duplicate: true }));
    await expect(call()).resolves.toMatchObject({ duplicate: true });
    expect(h.deletePrivate).toHaveBeenCalledWith('instapay-refunds/shot.png');
    expect(h.updateStatus).toHaveBeenCalledWith('s1', 'o1', 'refunded');
  });

  it('a replay on an order already refunded flips nothing', async () => {
    h.money.instapayRefundRecord.mockResolvedValueOnce(
      answer({ duplicate: true, orderStatus: 'refunded' })
    );
    await call();
    expect(h.updateStatus).not.toHaveBeenCalled();
  });

  it('a partial refund never touches the order status', async () => {
    h.money.instapayRefundRecord.mockResolvedValueOnce(
      answer({ full: false, status: 'partially_refunded' })
    );
    await call();
    expect(h.updateStatus).not.toHaveBeenCalled();
  });

  it('the DO refuses (over the remaining amount): nothing committed, the screenshot is freed', async () => {
    h.money.instapayRefundRecord.mockRejectedValueOnce(
      Object.assign(new Error('Refund must be between 1 and 100 piastres'), { statusCode: 400 })
    );
    await expect(call()).rejects.toThrow(/between 1 and/);
    expect(h.deletePrivate).toHaveBeenCalledWith('instapay-refunds/shot.png');
    expect(h.updateStatus).not.toHaveBeenCalled();
  });

  it('#629: a partial refund is booked like a gateway partial (GL + credit note keyed on the bank reference), never flips the order', async () => {
    h.money.instapayRefundRecord.mockResolvedValueOnce(
      answer({ full: false, status: 'partially_refunded', refundedAmount: 9000 })
    );
    await call();
    expect(h.updateStatus).not.toHaveBeenCalled();
    expect(h.recordRefundOutsideReturn).toHaveBeenCalledWith(
      's1',
      'o1',
      { providerRefundId: 'instapay:11112222', amount: 9000 },
      { sendNow: true }
    );
  });

  it('#629: a replay of a partial re-sends the (idempotent) booking so a failed first send converges', async () => {
    h.money.instapayRefundRecord.mockResolvedValueOnce(
      answer({ duplicate: true, full: false, status: 'partially_refunded' })
    );
    await call();
    expect(h.recordRefundOutsideReturn).toHaveBeenCalledTimes(1);
  });

  it('#629: a full refund is NOT booked as a partial (the order flip runs the whole reversal)', async () => {
    h.money.instapayRefundRecord.mockResolvedValueOnce(answer({}));
    await call();
    expect(h.recordRefundOutsideReturn).not.toHaveBeenCalled();
  });
});
