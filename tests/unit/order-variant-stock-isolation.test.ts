/**
 * Invariant: one order line writes the variant row XOR the product row.
 *
 * Checkout used to decrement BOTH for a variant sale, which drove the parent
 * column of every variant product monotonically negative (24 live products,
 * to -16 at worst, while their variants held four-figure stock). The refund
 * path incremented both, and the payment rollback incremented ONLY the
 * product — so the two directions never even cancelled out.
 *
 * The checkout transaction is a 400-line interactive Prisma tx whose faithful
 * mock would assert the mock, so the create path is pinned structurally. The
 * payment rollback is small enough to RUN: it is exercised against a fake tx
 * and the writes it issues are observed. The refund restore stays a shape check.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as decrement from '@api/services/inventory-decrement';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const { tx } = vi.hoisted(() => ({
  tx: {
    order: { findFirst: vi.fn(), update: vi.fn().mockResolvedValue({}) },
    bundle: { findMany: vi.fn().mockResolvedValue([]) },
    product: { findUnique: vi.fn(), update: vi.fn().mockResolvedValue({}) },
    productVariant: { update: vi.fn() },
    inventoryHistory: { create: vi.fn().mockResolvedValue({}) },
    coupon: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
    orderEvent: { create: vi.fn().mockResolvedValue({}) },
    cart: { findFirst: vi.fn().mockResolvedValue({ id: 'cart-1' }), create: vi.fn() },
    cartItem: { deleteMany: vi.fn().mockResolvedValue({}), create: vi.fn().mockResolvedValue({}) },
    cartBundle: {
      deleteMany: vi.fn().mockResolvedValue({}),
      create: vi.fn().mockResolvedValue({}),
    },
  },
}));

vi.mock('@api/services/fiscal-document.service', () => ({
  FiscalDocumentService: {
    issueSaleDocument: vi.fn().mockResolvedValue(null),
    cancelSaleDocument: vi.fn().mockResolvedValue(null),
    issueRefundDocument: vi.fn().mockResolvedValue(null),
  },
}));
vi.mock('@api/services/payment-providers/cod.provider', async importOriginal => ({
  ...(await importOriginal<typeof import('@api/services/payment-providers/cod.provider')>()),
  loadCodFeeConfig: vi.fn().mockResolvedValue(null),
}));
vi.mock('@ebda/database', () => ({
  prisma: {
    $transaction: vi.fn(),
    $queryRaw: vi.fn(),
    product: { findMany: vi.fn().mockResolvedValue([]) },
    store: { findUnique: vi.fn().mockResolvedValue({ slug: 'demo' }) },
  },
  Prisma: {},
  OrderStatus: {},
  runInTenantContext: (_storeId: string, fn: () => unknown) => fn(),
  withMoneyTx: (_client: unknown, fn: (t: unknown) => unknown) => fn(tx),
}));
vi.mock('@api/lib/inngest/client', () => ({
  inngest: { send: vi.fn().mockResolvedValue({ ids: [] }), createFunction: vi.fn(() => ({})) },
}));
vi.mock('@api/services/socket.service', () => ({
  socketService: { newOrderNotification: vi.fn(), orderStatusNotification: vi.fn() },
}));
vi.mock('@api/services/email.service', () => ({ EmailService: {} }));
vi.mock('@api/lib/public-cache', () => ({
  invalidateStoreProductCaches: vi.fn().mockResolvedValue(undefined),
  invalidateCustomersCache: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@api/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { OrderService } from '@api/services/order.service';

const read = (p: string) => readFileSync(resolve(__dirname, '../..', p), 'utf8');

describe('inventory-decrement module surface', () => {
  it('no longer exports an unfloored product force-decrement', () => {
    expect('forceDecrementProductInventory' in decrement).toBe(false);
  });

  it('still exports the three helpers the order path needs', () => {
    expect(typeof decrement.decrementProductInventory).toBe('function');
    expect(typeof decrement.decrementVariantInventory).toBe('function');
    expect(typeof decrement.forceDecrementVariantInventory).toBe('function');
  });
});

describe('order paths never write both rows for one line', () => {
  it('order.service.ts has no product force-decrement left', () => {
    expect(read('apps/api/src/services/order.service.ts')).not.toContain(
      'forceDecrementProductInventory'
    );
  });

  it('the refund restore guards the product increment behind "no variantId"', () => {
    const src = read('apps/api/src/lib/inngest/functions/order-refunded.ts');
    // The variant branch must come first and the product increment must sit
    // in its else-branch — not unconditionally above it, as it used to.
    expect(src).toMatch(
      /if \(item\.variantId\) \{[\s\S]{0,600}?productVariant\.update[\s\S]{0,400}?\} else \{[\s\S]{0,400}?product\.update/
    );
  });

  describe('the payment rollback', () => {
    beforeEach(() => {
      vi.clearAllMocks();
      tx.product.findUnique.mockResolvedValue({ trackInventory: true, inventory: 10 });
      tx.productVariant.update.mockResolvedValue({ inventory: 7 });
      tx.cart.findFirst.mockResolvedValue({ id: 'cart-1' });
      tx.order.findFirst.mockResolvedValue({
        id: 'order-1',
        storeId: 'store-1',
        status: 'pending',
        customerId: null,
        notes: null,
        payments: [],
        couponCode: null,
        items: [
          { id: 'oi-1', productId: 'p-variant', variantId: 'v-1', quantity: 2 },
          { id: 'oi-2', productId: 'p-plain', variantId: null, quantity: 3 },
        ],
      });
    });

    it('restores the variant row for a variant line and the product row only for a plain line', async () => {
      await OrderService.rollbackForPaymentFailure('store-1', 'order-1', 'sess-1');

      expect(tx.productVariant.update).toHaveBeenCalledTimes(1);
      expect(tx.productVariant.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'v-1' },
          data: { inventory: { increment: 2 } },
        })
      );
      // One writer per line: the variant line must NOT also credit its parent product.
      expect(tx.product.update).toHaveBeenCalledTimes(1);
      expect(tx.product.update).toHaveBeenCalledWith({
        where: { id: 'p-plain', storeId: 'store-1' },
        data: { inventory: { increment: 3 } },
      });
    });
  });
});
