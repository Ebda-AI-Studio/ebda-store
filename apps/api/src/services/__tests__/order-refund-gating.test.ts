import { describe, it, expect, vi, beforeEach } from 'vitest';
import { hasCapturedPayment, shouldApplyRefundEffects } from '../order-refund-gating';

// Mock dependencies transitively pulled in by order.service.ts. Mirrors the
// mock shape in tests/unit/order.test.ts (kept minimal here — this file only
// exercises `applyRefundEffects`, not the rest of OrderService).
vi.mock('@ebda/database', () => ({
  prisma: {
    order: {
      findFirst: vi.fn(),
      updateMany: vi.fn(),
    },
    // A partial event arms its own Return (issues 2246 / 2267).
    return: {
      updateMany: vi.fn(),
    },
    // These money-reversal tables must NOT be touched by applyRefundEffects
    // anymore (Task 1 of the money-integrity redesign) — the assertions
    // below confirm it via `.not.toHaveBeenCalled()`.
    coupon: {
      updateMany: vi.fn(),
    },
    backorderLine: {
      updateMany: vi.fn(),
    },
    inventoryHistory: {
      findFirst: vi.fn(),
      create: vi.fn(),
    },
    orderEvent: {
      findFirst: vi.fn(),
      create: vi.fn(),
    },
    product: { update: vi.fn() },
    productVariant: { update: vi.fn() },
    $transaction: vi.fn(),
  },
  Prisma: {},
  OrderStatus: {},
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  withMoneyTx: (client: any, fn: any) =>
    client?.$transaction ? client.$transaction(fn) : fn(client),
}));

vi.mock('../../lib/inngest/client', () => ({
  inngest: {
    send: vi.fn().mockResolvedValue({ ids: [] }),
    createFunction: vi.fn(() => ({})),
  },
}));

vi.mock('../affiliate.service', () => ({
  affiliateService: {
    reverseCommission: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('../loyalty.service', () => ({
  LoyaltyService: {
    reverseEarnedPointsFromOrder: vi.fn().mockResolvedValue(undefined),
    reverseRedeemedPointsFromOrder: vi.fn().mockResolvedValue(undefined),
  },
  computeRedemption: vi.fn(),
}));

vi.mock('../../lib/public-cache', () => ({
  invalidateStoreProductCaches: vi.fn().mockResolvedValue(undefined),
  invalidateCustomersCache: vi.fn().mockResolvedValue(undefined),
}));

import { prisma } from '@ebda/database';
import { inngest } from '../../lib/inngest/client';
import { affiliateService } from '../affiliate.service';
import { LoyaltyService } from '../loyalty.service';
import { OrderService } from '../order.service';

describe('hasCapturedPayment', () => {
  it('true when durable paymentStatus is paid', () => {
    expect(hasCapturedPayment({ paymentStatus: 'paid' })).toBe(true);
  });

  it('true when a payment row reached completed even if paymentStatus lags', () => {
    expect(
      hasCapturedPayment({ paymentStatus: 'unpaid', payments: [{ status: 'completed' }] })
    ).toBe(true);
  });

  it('false for an unpaid order with no completed payment', () => {
    expect(hasCapturedPayment({ paymentStatus: 'unpaid', payments: [{ status: 'pending' }] })).toBe(
      false
    );
  });

  it('false for an unpaid order with no payment rows', () => {
    expect(hasCapturedPayment({ paymentStatus: 'unpaid' })).toBe(false);
    expect(hasCapturedPayment({ paymentStatus: 'unpaid', payments: [] })).toBe(false);
    expect(hasCapturedPayment({})).toBe(false);
  });

  it('false when payment is failed (not completed)', () => {
    expect(hasCapturedPayment({ paymentStatus: 'failed', payments: [{ status: 'failed' }] })).toBe(
      false
    );
  });
});

describe('shouldApplyRefundEffects — the cancel/refund side-effects gate', () => {
  it('cancelling an UNPAID order does NOT apply refund effects (no "Refund issued" push)', () => {
    // The core bug: an online order whose payment link was never completed.
    const unpaidOrder = { paymentStatus: 'unpaid', payments: [{ status: 'pending' }] };
    expect(shouldApplyRefundEffects('cancelled', unpaidOrder)).toBe(false);
  });

  it('cancelling a PAID order DOES apply refund effects (refund + "Refund issued")', () => {
    const paidOrder = { paymentStatus: 'paid', payments: [{ status: 'completed' }] };
    expect(shouldApplyRefundEffects('cancelled', paidOrder)).toBe(true);
  });

  it('refunding a PAID order applies refund effects', () => {
    expect(shouldApplyRefundEffects('refunded', { paymentStatus: 'paid' })).toBe(true);
  });

  it('refunding an order with no captured payment does not apply refund effects (defensive)', () => {
    expect(shouldApplyRefundEffects('refunded', { paymentStatus: 'unpaid' })).toBe(false);
  });

  it('non-terminal statuses never apply refund effects regardless of payment', () => {
    const paidOrder = { paymentStatus: 'paid' };
    for (const status of ['pending', 'confirmed', 'processing', 'shipped', 'delivered']) {
      expect(shouldApplyRefundEffects(status, paidOrder)).toBe(false);
    }
  });

  // F2 rework (2026-07-02): a refunded→cancelled bookkeeping close-out must
  // NOT fire a second "Refund issued" notification — the customer was
  // already told when the order first became refunded.
  describe('refunded→cancelled bookkeeping close-out (wasAlreadyRefunded)', () => {
    it('cancelling an order that is ALREADY refunded does NOT re-apply refund effects', () => {
      const alreadyRefundedOrder = { paymentStatus: 'paid', status: 'refunded' };
      expect(shouldApplyRefundEffects('cancelled', alreadyRefundedOrder)).toBe(false);
    });

    it('cancelling a paid order that was NOT already refunded still applies refund effects', () => {
      const paidNotYetRefunded = { paymentStatus: 'paid', status: 'delivered' };
      expect(shouldApplyRefundEffects('cancelled', paidNotYetRefunded)).toBe(true);
    });

    it('refunding a paid order for the first time (status not yet refunded) applies refund effects', () => {
      const firstRefund = { paymentStatus: 'paid', status: 'delivered' };
      expect(shouldApplyRefundEffects('refunded', firstRefund)).toBe(true);
    });

    it('omitting `status` entirely preserves the old paymentStatus-only behavior (backward compatible)', () => {
      const paidOrderNoStatus = { paymentStatus: 'paid' };
      expect(shouldApplyRefundEffects('cancelled', paidOrderNoStatus)).toBe(true);
    });
  });
});

// Money-integrity redesign, Task 1 (2026-07-16): `applyRefundEffects` is no
// longer where the reversals run — it's a thin dispatcher that fires
// `order/refunded` with the reversal flags. The inline inventory/coupon/
// affiliate/loyalty/backorder reversals move into the `order-refunded`
// Inngest fanout as idempotent steps in Tasks 2-3 (not yet landed as of this
// test) — until then, cancel/refund no longer reverses money inline, which is
// expected: the event now carries everything the fanout needs to do it.
describe('OrderService.applyRefundEffects — fires order/refunded with reversal flags', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.order.findFirst).mockResolvedValue({ id: 'order-123' } as any);
  });

  it('fires order/refunded once with restoreInventory:true, notify:false for an UNPAID cancel', async () => {
    // Mirrors updateStatus's call for an unpaid cancel: shouldApplyRefundEffects
    // resolves to false (no captured payment), so fireRefundNotification:false —
    // but the reversal flags must still fire (stock/coupons were reserved).
    await OrderService.applyRefundEffects('store-1', 'order-123', {
      restoreInventory: true,
      fireRefundNotification: false,
    });

    expect(inngest.send).toHaveBeenCalledTimes(1);
    expect(inngest.send).toHaveBeenCalledWith({
      name: 'order/refunded',
      data: {
        orderId: 'order-123',
        storeId: 'store-1',
        restoreInventory: true,
        notify: false,
        reverseWallet: true,
      },
    });
  });

  it('fires order/refunded once with restoreInventory:true, notify:true for a paid refund (defaults)', async () => {
    await OrderService.applyRefundEffects('store-1', 'order-123');

    expect(inngest.send).toHaveBeenCalledTimes(1);
    expect(inngest.send).toHaveBeenCalledWith({
      name: 'order/refunded',
      data: {
        orderId: 'order-123',
        storeId: 'store-1',
        restoreInventory: true,
        notify: true,
        reverseWallet: true,
      },
    });
  });

  it('carries restoreInventory:false through (e.g. a backorder-line cancel)', async () => {
    await OrderService.applyRefundEffects('store-1', 'order-123', {
      restoreInventory: false,
      fireRefundNotification: false,
    });

    expect(inngest.send).toHaveBeenCalledWith({
      name: 'order/refunded',
      data: {
        orderId: 'order-123',
        storeId: 'store-1',
        restoreInventory: false,
        notify: false,
        reverseWallet: true,
      },
    });
  });

  it('no longer performs any inline reversal — no coupon/affiliate/loyalty/backorder/inventory writes', async () => {
    await OrderService.applyRefundEffects('store-1', 'order-123');

    expect(prisma.coupon.updateMany).not.toHaveBeenCalled();
    expect(affiliateService.reverseCommission).not.toHaveBeenCalled();
    expect(LoyaltyService.reverseEarnedPointsFromOrder).not.toHaveBeenCalled();
    expect(LoyaltyService.reverseRedeemedPointsFromOrder).not.toHaveBeenCalled();
    expect(prisma.backorderLine.updateMany).not.toHaveBeenCalled();
    expect(prisma.inventoryHistory.create).not.toHaveBeenCalled();
    // The premature `refund_effects_applied` marker is gone too.
    expect(prisma.orderEvent.create).not.toHaveBeenCalled();
  });

  // #839/#855/#858 — every whole-order stock-restoring enqueue arms the
  // stuck-reversal sweep: request stamp + re-nulled completion claim.
  it('arms the stuck-reversal sweep for a whole-order stock-restoring event', async () => {
    await OrderService.applyRefundEffects('store-1', 'order-123');
    expect(prisma.order.updateMany).toHaveBeenCalledWith({
      where: { id: 'order-123', storeId: 'store-1' },
      data: { refundReversalRequestedAt: expect.any(Date), refundReversedAt: null },
    });
  });

  it('does NOT arm the sweep for a backorder-line cancel or a partial return', async () => {
    await OrderService.applyRefundEffects('store-1', 'order-123', { restoreInventory: false });
    await OrderService.applyRefundEffects('store-1', 'order-123', {
      partial: { items: [{ orderItemId: 'oi-1', quantity: 1 }], refundKey: 'ret-1' },
    });
    expect(prisma.order.updateMany).not.toHaveBeenCalled();
    expect(inngest.send).toHaveBeenCalledTimes(2);
    // …but the partial arms ITS Return, so the partial sweep can recover it.
    expect(prisma.return.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.return.updateMany).toHaveBeenCalledWith({
      where: { id: 'ret-1', storeId: 'store-1', orderId: 'order-123' },
      data: { reversalRequestedAt: expect.any(Date), reversalAppliedAt: null },
    });
  });

  it('is a no-op (no event fired) when the order does not exist', async () => {
    vi.mocked(prisma.order.findFirst).mockResolvedValue(null);

    await OrderService.applyRefundEffects('store-1', 'missing-order');

    expect(inngest.send).not.toHaveBeenCalled();
  });
});

// PR #770: a paid order can now go cancelled → refunded. The status-level
// predicate must still say "notify" there: whether the customer was already
// told is decided by the per-order `refund_notified` claim in the fanout
// (see tests/unit/order-refunded-reversals.test.ts), because an order
// cancelled while UNPAID and paid afterwards was never told.
describe('refund notification after a cancel (PR #770)', () => {
  it('a paid, cancelled order being refunded still asks to notify', () => {
    expect(
      shouldApplyRefundEffects('refunded', {
        status: 'cancelled',
        paymentStatus: 'paid',
        payments: [],
      })
    ).toBe(true);
  });

  it('an already-refunded order never notifies again', () => {
    expect(
      shouldApplyRefundEffects('cancelled', {
        status: 'refunded',
        paymentStatus: 'paid',
        payments: [],
      })
    ).toBe(false);
  });
});
