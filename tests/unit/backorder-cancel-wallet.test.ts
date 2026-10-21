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
  inTenant: false,
  withMoneyTx: vi.fn(),
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
  // The #2277 debt heal locks the product row; not negative here → no heal
  // (the heal itself is proven against a real DB in
  // tests/integration/accounting/backorder-cancel-stock-heal.test.ts).
  $queryRaw: vi.fn(),
};

vi.mock('@ebda/database', () => ({
  // Inside a request the service runs on the ambient (proxied) client, so the
  // mock `prisma` carries the same tx accessors.
  prisma: new Proxy(
    { backorderLine: { findFirst: h.findFirst } },
    {
      get: (target: any, key: string) =>
        key === 'backorderLine'
          ? { ...tx.backorderLine, findFirst: h.findFirst }
          : (target[key] ?? (tx as any)[key]),
    }
  ),
  Prisma: {},
  hasTenantContext: () => h.inTenant,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  withMoneyTx: (_c: any, fn: any) => {
    h.withMoneyTx();
    return fn(tx);
  },
}));
vi.mock('@api/services/order.service', () => ({
  OrderService: { applyRefundEffects: h.applyRefundEffects },
}));
vi.mock('@api/lib/public-cache', () => ({ invalidateStoreProductCaches: vi.fn() }));
vi.mock('@api/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { cancelBackorder } from '@api/services/accounting/backorder.service';

beforeEach(() => {
  h.findFirst.mockResolvedValue({
    id: 'bo1',
    orderItemId: 'oi1',
    productId: 'p1',
    variantId: null,
    orderItem: { id: 'oi1', orderId: 'o1' },
  });
  tx.$queryRaw.mockResolvedValue([{ inventory: 0, track_inventory: true }]);
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
    const res = await cancelBackorder('s1', 'bo1', 'supplier cancelled', 'u1');
    // Issue 2275 — the admin is told what it still owes; no money moved.
    expect(res.owedToCustomer).toBe(2000);
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
    const res = await cancelBackorder('s1', 'bo1', 'r');
    expect(h.applyRefundEffects).toHaveBeenLastCalledWith(
      's1',
      'o1',
      expect.objectContaining({ fireRefundNotification: false })
    );
    // Nothing was taken, so nothing is owed.
    expect(res.owedToCustomer).toBe(0);
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

/**
 * Issue 2274 — a line whose allocation is ZERO (its units already reversed by
 * a prior return, or a fully discounted order) must not tell the customer a
 * refund was issued; the consumer used to turn `refundAmount: 0` into the
 * ORDER TOTAL. Mutation proof: drop `&& alloc.cashCredit > 0` → red.
 */
describe('cancelBackorder — a zero allocation notifies nobody (issue 2274)', () => {
  it('fully discounted order: GL adjustment still fires, the customer is not told', async () => {
    h.applyRefundEffects.mockClear();
    tx.order.findUniqueOrThrow.mockResolvedValueOnce({
      subtotal: 3000,
      discount: 3000,
      tax: 0,
      taxIncludedInPrice: false,
      paymentStatus: 'paid',
      items: [
        { id: 'oi1', quantity: 2, price: 1000 },
        { id: 'oi2', quantity: 1, price: 1000 },
      ],
    });
    await cancelBackorder('s1', 'bo1', 'r');
    expect(h.applyRefundEffects).toHaveBeenCalledWith(
      's1',
      'o1',
      expect.objectContaining({
        fireRefundNotification: false,
        partial: expect.objectContaining({ refundAmount: 0 }),
      })
    );
  });
});

/**
 * Issue 2276 — inside a request the claim + marker must ride the request's
 * transaction (one commit decision with the deferred `order/refunded` send),
 * not a separate `withMoneyTx` that commits on its own.
 * Mutation proof: always call `withMoneyTx` → the first case goes red.
 */
describe('cancelBackorder — transaction ownership (issue 2276)', () => {
  it('inside a request, runs on the ambient transaction (no nested withMoneyTx)', async () => {
    h.withMoneyTx.mockClear();
    h.inTenant = true;
    try {
      await cancelBackorder('s1', 'bo1', 'r');
    } finally {
      h.inTenant = false;
    }
    expect(h.withMoneyTx).not.toHaveBeenCalled();
    expect(tx.orderEvent.create).toHaveBeenCalled();
  });

  it('outside a request, opens its own money transaction', async () => {
    h.withMoneyTx.mockClear();
    await cancelBackorder('s1', 'bo1', 'r');
    expect(h.withMoneyTx).toHaveBeenCalledTimes(1);
  });
});

describe('cancelBackorder — the same allocation the GL posts (B2B Task 8b tier adjustments)', () => {
  it('counts the tier adjustments earlier returns retained, as partial-return-posting does: owed == GL cash credit', async () => {
    const { allocatePartialReturn } =
      await import('@api/services/accounting/posting/partial-return-allocation');
    // oi1: one base line, backordered and cancelled. oi2: 100 tier-priced units, 90 returned earlier with 200 retained.
    const items = [
      { id: 'oi1', quantity: 1, price: 999, priceSource: 'base' },
      { id: 'oi2', quantity: 100, price: 80, priceSource: 'tier' },
    ];
    tx.order.findUniqueOrThrow.mockResolvedValueOnce({
      subtotal: 8999,
      discount: 0,
      tax: 15,
      taxIncludedInPrice: false,
      paymentStatus: 'paid',
      items,
    });
    tx.backorderLine.findUniqueOrThrow.mockResolvedValueOnce({ qty: 1, qtyFulfilled: 0 });
    tx.return.findMany.mockResolvedValueOnce([
      {
        id: 'r1',
        reason: null,
        items: [{ orderItemId: 'oi2', quantity: 90, tierAdjustment: 200 }],
      },
    ]);
    const res = await cancelBackorder('s1', 'bo1', 'r');
    const base = {
      subtotal: 8999,
      discount: 0,
      tax: 15,
      taxIncludedInPrice: false,
      lines: items,
      prevQty: new Map([['oi2', 90]]),
      requested: [{ orderItemId: 'oi1', quantity: 1 }],
    };
    // What partial-return-posting credits to cash for this cancel (it passes the loader's prevAdjustment)
    const gl = allocatePartialReturn({ ...base, prevAdjustment: 200 }).cashCredit;
    expect(gl).not.toBe(allocatePartialReturn(base).cashCredit); // the case where ignoring it disagrees (1 piastre)
    expect(res.owedToCustomer).toBe(gl);
  });
});
