/**
 * Backorder single-LINE cancel fires an ITEM-LEVEL `order/refunded` event
 * (owner decision 2026-09-30, ruling AP-5) — never the whole-order one.
 *
 * The whole-order event reversed the entire sale in the GL, released the
 * coupon, clawed back affiliate commission and loyalty, cancelled every other
 * open backorder line and — without `reverseWallet: false` — handed back the
 * order's whole customer-wallet spend (D1), all for one line of a live order.
 * The partial payload is what makes every consumer act on this line only;
 * the DB-backed ledger proof is
 * tests/integration/accounting/backorder-line-cancel-ledger.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  findFirst: vi.fn(),
  applyRefundEffects: vi.fn().mockResolvedValue(undefined),
}));

const tx = {
  backorderLine: {
    updateMany: vi.fn(),
    findUniqueOrThrow: vi.fn(),
    count: vi.fn(),
  },
  orderItem: { update: vi.fn() },
  orderEvent: { create: vi.fn(), findMany: vi.fn() },
  order: { findUniqueOrThrow: vi.fn() },
  return: { findMany: vi.fn() },
};

vi.mock('@force/database', () => ({
  prisma: { backorderLine: { findFirst: h.findFirst } },
  Prisma: {},
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  withMoneyTx: (_c: any, fn: any) => fn(tx),
}));
vi.mock('@api/services/order.service', () => ({
  OrderService: { applyRefundEffects: h.applyRefundEffects },
}));
vi.mock('@api/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { cancelBackorder } from '@api/services/accounting/backorder.service';

beforeEach(() => {
  h.findFirst.mockResolvedValue({
    id: 'bo1',
    orderItemId: 'oi1',
    orderItem: { id: 'oi1', orderId: 'o1' },
  });
  tx.backorderLine.updateMany.mockResolvedValue({ count: 1 });
  tx.backorderLine.findUniqueOrThrow.mockResolvedValue({ qty: 2, qtyFulfilled: 0 });
  tx.backorderLine.count.mockResolvedValue(0);
  tx.orderEvent.findMany.mockResolvedValue([]);
  tx.return.findMany.mockResolvedValue([]);
  tx.order.findUniqueOrThrow.mockResolvedValue({
    subtotal: 3000,
    discount: 0,
    tax: 0,
    taxIncludedInPrice: false,
    paymentStatus: 'paid',
    items: [
      { id: 'oi1', quantity: 2, price: 1000 },
      { id: 'oi2', quantity: 1, price: 1000 },
    ],
  });
});

describe('cancelBackorder → order/refunded', () => {
  it('fires the item-level event for this line only, never the whole-order one', async () => {
    await cancelBackorder('s1', 'bo1', 'supplier cancelled', 'u1');
    expect(h.applyRefundEffects).toHaveBeenCalledWith('s1', 'o1', {
      restoreInventory: false,
      reverseWallet: false,
      fireRefundNotification: true,
      partial: {
        items: [{ orderItemId: 'oi1', quantity: 2 }],
        refundKey: 'backorder:bo1',
        refundAmount: 2000,
        backorderLineId: 'bo1',
      },
    });
  });

  it('does not claim a refund was issued on an unpaid order', async () => {
    tx.order.findUniqueOrThrow.mockResolvedValueOnce({
      subtotal: 3000,
      discount: 0,
      tax: 0,
      taxIncludedInPrice: false,
      paymentStatus: 'unpaid',
      items: [{ id: 'oi1', quantity: 2, price: 1000 }],
    });
    await cancelBackorder('s1', 'bo1', 'r');
    expect(h.applyRefundEffects).toHaveBeenLastCalledWith(
      's1',
      'o1',
      expect.objectContaining({ fireRefundNotification: false })
    );
  });

  it('a lost cancel race is a 404 with no event', async () => {
    h.applyRefundEffects.mockClear();
    tx.backorderLine.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(cancelBackorder('s1', 'bo1', 'r')).rejects.toMatchObject({ statusCode: 404 });
    expect(h.applyRefundEffects).not.toHaveBeenCalled();
    expect(tx.orderEvent.create).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ orderId: 'o1' }) })
    );
  });
});
