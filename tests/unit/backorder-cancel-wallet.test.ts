/**
 * Backorder single-LINE cancel must never return the order's customer-wallet
 * spend (D1).
 *
 * `cancelBackorder` borrows the whole-order `order/refunded` event for ONE
 * line. The fanout's `reverse-wallet-payment` step puts back the entire
 * wallet portion of the order unless the event says `reverseWallet: false`,
 * so this call site must say it — otherwise cancelling one backordered line
 * of a live order would hand the customer back the whole wallet payment while
 * the rest of the order still ships.
 */
import { describe, it, expect, vi } from 'vitest';

const h = vi.hoisted(() => ({
  findFirst: vi.fn(),
  applyRefundEffects: vi.fn().mockResolvedValue(undefined),
}));

const tx = {
  backorderLine: { update: vi.fn(), count: vi.fn().mockResolvedValue(0) },
  orderItem: { update: vi.fn() },
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

describe('cancelBackorder → order/refunded', () => {
  it('opts out of the whole-order wallet reversal', async () => {
    h.findFirst.mockResolvedValue({
      id: 'bo1',
      orderItemId: 'oi1',
      orderItem: { id: 'oi1', orderId: 'o1' },
    });
    await cancelBackorder('s1', 'bo1', 'supplier cancelled', 'u1');
    expect(h.applyRefundEffects).toHaveBeenCalledWith(
      's1',
      'o1',
      expect.objectContaining({ restoreInventory: false, reverseWallet: false })
    );
  });
});
