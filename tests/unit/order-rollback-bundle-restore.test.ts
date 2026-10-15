/**
 * P1-1 (final review): a failed payment must not silently convert a bundle
 * order back into full-price loose lines.
 *
 * `rollbackForPaymentFailure` rebuilds the customer's cart from the order so
 * they can retry. It used to aggregate EVERY `OrderItem` — including the
 * component lines a box expanded into — into loose `CartItem` rows.
 * `CartService.getOrCreate` then priced those through `cartLineUnitPrice` at
 * shelf price, so a customer who failed payment on a 12.000 EGP "Ramadan
 * Box" (componentSum 14.500) came back to a 14.500 cart with no explanation
 * and, if they retried, paid 2.500 more than they intended while the
 * merchant's bundle never sold.
 *
 * `CartBundle` exists precisely for this and the checkout path already
 * writes to it, so the restore recreates the box.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { computeBundlePrice } from '@ebda/shared';
import { restoreCartShape } from '@api/lib/order-cart-restore';

// ─── Part 1: the restore shape (pure) ───────────────────────────────────────

const box = (groupId: string, productId: string, quantity = 1) => ({
  productId,
  variantId: null,
  quantity,
  bundleId: 'bundle-1',
  bundleGroupId: groupId,
});

describe('restoreCartShape', () => {
  it('recreates one CartBundle per bundle, quantity = number of boxes ordered', () => {
    // Two boxes of the same bundle: three components each, one group id per box.
    const restored = restoreCartShape([
      box('grp-a', 'p-dates'),
      box('grp-a', 'p-honey'),
      box('grp-a', 'p-nuts', 2),
      box('grp-b', 'p-dates'),
      box('grp-b', 'p-honey'),
      box('grp-b', 'p-nuts', 2),
    ]);

    expect(restored.bundles).toEqual([{ bundleId: 'bundle-1', quantity: 2 }]);
    // The components must NOT come back as loose lines — that is the defect.
    expect(restored.items).toEqual([]);
  });

  it('keeps personalised lines apart and restores their note', () => {
    const line = (personalisation: string | null, quantity = 1) => ({
      productId: 'p-abaya',
      variantId: 'v-m',
      quantity,
      bundleId: null,
      bundleGroupId: null,
      personalisation,
    });
    const restored = restoreCartShape([line('Sara'), line('Omar'), line('Sara', 2), line(null)]);
    expect(restored.items).toEqual([
      { productId: 'p-abaya', variantId: 'v-m', quantity: 3, note: 'Sara' },
      { productId: 'p-abaya', variantId: 'v-m', quantity: 1, note: 'Omar' },
      { productId: 'p-abaya', variantId: 'v-m', quantity: 1 },
    ]);
  });

  it('keeps genuinely loose lines, aggregated by (productId, variantId)', () => {
    const restored = restoreCartShape([
      box('grp-a', 'p-dates'),
      { productId: 'p-dates', variantId: null, quantity: 1, bundleId: null, bundleGroupId: null },
      { productId: 'p-tea', variantId: 'v-1', quantity: 2, bundleId: null, bundleGroupId: null },
      { productId: 'p-tea', variantId: 'v-1', quantity: 3, bundleId: null, bundleGroupId: null },
    ]);

    expect(restored.bundles).toEqual([{ bundleId: 'bundle-1', quantity: 1 }]);
    expect(restored.items).toEqual([
      { productId: 'p-dates', variantId: undefined, quantity: 1 },
      { productId: 'p-tea', variantId: 'v-1', quantity: 5 },
    ]);
  });

  it('is the identity aggregation for an order with no bundle lines', () => {
    const restored = restoreCartShape([
      { productId: 'p-1', variantId: null, quantity: 2 },
      { productId: 'p-2', variantId: 'v-9', quantity: 1 },
    ]);

    expect(restored.bundles).toEqual([]);
    expect(restored.items).toEqual([
      { productId: 'p-1', variantId: undefined, quantity: 2 },
      { productId: 'p-2', variantId: 'v-9', quantity: 1 },
    ]);
  });

  it('falls back to loose lines when the bundle itself no longer exists', () => {
    // `OrderItem.bundleId` has no FK to `Bundle`, so the id it names can be
    // gone. Writing a `cart_bundles` row for it would raise a FK violation
    // and abort the whole compensating transaction — stranding the order in
    // `pending` with its inventory unrestored, strictly worse than the
    // mispricing this function fixes.
    const items = [box('grp-a', 'p-dates'), box('grp-a', 'p-honey')];

    const gone = restoreCartShape(items, new Set<string>());
    expect(gone.bundles).toEqual([]);
    expect(gone.items).toEqual([
      { productId: 'p-dates', variantId: undefined, quantity: 1 },
      { productId: 'p-honey', variantId: undefined, quantity: 1 },
    ]);

    // …and the box IS restored when the bundle is still there.
    const live = restoreCartShape(items, new Set(['bundle-1']));
    expect(live.bundles).toEqual([{ bundleId: 'bundle-1', quantity: 1 }]);
    expect(live.items).toEqual([]);
  });

  it('restores an unattributable bundle line as loose rather than dropping it', () => {
    const restored = restoreCartShape([
      { productId: 'p-1', variantId: null, quantity: 1, bundleId: 'bundle-1', bundleGroupId: null },
    ]);

    expect(restored.bundles).toEqual([]);
    expect(restored.items).toEqual([{ productId: 'p-1', variantId: undefined, quantity: 1 }]);
  });

  it('the restored cart prices at the bundle price, not the component sum', () => {
    const COMPONENT_SUM = 14500;
    const BUNDLE_PRICE = computeBundlePrice(COMPONENT_SUM, 'fixed_price', 12000);
    const restored = restoreCartShape([
      box('grp-a', 'p-dates'),
      box('grp-a', 'p-honey'),
      box('grp-a', 'p-nuts', 2),
    ]);

    // One CartBundle row → CartService prices it via resolveBundle at the
    // bundle price. Nothing loose is left to be priced at shelf price.
    const cartTotal = restored.bundles.reduce((sum, b) => sum + BUNDLE_PRICE * b.quantity, 0);
    expect(cartTotal).toBe(12000);
    expect(cartTotal).not.toBe(COMPONENT_SUM);
  });
});

// ─── Part 2: the rollback writes those rows ─────────────────────────────────

const { mockPrisma, tx } = vi.hoisted(() => {
  const tx = {
    order: { findFirst: vi.fn(), update: vi.fn().mockResolvedValue({}) },
    bundle: { findMany: vi.fn().mockResolvedValue([{ id: 'bundle-1' }]) },
    product: { findUnique: vi.fn().mockResolvedValue({ trackInventory: false, inventory: 0 }) },
    productVariant: { update: vi.fn() },
    inventoryHistory: { create: vi.fn().mockResolvedValue({}) },
    coupon: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
    cart: { findFirst: vi.fn().mockResolvedValue({ id: 'cart-1' }), create: vi.fn() },
    cartItem: { deleteMany: vi.fn().mockResolvedValue({}), create: vi.fn().mockResolvedValue({}) },
    cartBundle: {
      deleteMany: vi.fn().mockResolvedValue({}),
      create: vi.fn().mockResolvedValue({}),
    },
  };
  return {
    tx,
    mockPrisma: {
      $transaction: vi.fn(),
      $queryRaw: vi.fn(),
      product: { findMany: vi.fn().mockResolvedValue([]) },
      store: { findUnique: vi.fn().mockResolvedValue({ slug: 'demo' }) },
    },
  };
});

// Money batch B: fiscal documents + the frozen COD fee are covered end-to-end
// by tests/integration/fiscal-documents.test.ts; this unit suite stubs them.
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
  prisma: mockPrisma,
  Prisma: {},
  OrderStatus: {},
  runInTenantContext: (_storeId: string, fn: () => unknown) => fn(),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  withMoneyTx: (_client: any, fn: any) => fn(tx),
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

describe('rollbackForPaymentFailure — bundle restore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tx.cart.findFirst.mockResolvedValue({ id: 'cart-1' });
    tx.bundle.findMany.mockResolvedValue([{ id: 'bundle-1' }]);
    tx.product.findUnique.mockResolvedValue({ trackInventory: false, inventory: 0 });
    tx.order.findFirst.mockResolvedValue({
      id: 'order-1',
      storeId: 'store-1',
      status: 'pending',
      customerId: null,
      notes: null,
      payments: [],
      couponCode: null,
      items: [
        { ...box('grp-a', 'p-dates'), id: 'oi-1' },
        { ...box('grp-a', 'p-honey'), id: 'oi-2' },
        { ...box('grp-b', 'p-dates'), id: 'oi-3' },
        { ...box('grp-b', 'p-honey'), id: 'oi-4' },
        {
          id: 'oi-5',
          productId: 'p-tea',
          variantId: null,
          quantity: 1,
          bundleId: null,
          bundleGroupId: null,
        },
      ],
    });
  });

  it('writes one CartBundle at the box count and leaves the components out of the cart items', async () => {
    await OrderService.rollbackForPaymentFailure('store-1', 'order-1', 'sess-1');

    expect(tx.cartBundle.create).toHaveBeenCalledTimes(1);
    expect(tx.cartBundle.create).toHaveBeenCalledWith({
      data: { cartId: 'cart-1', bundleId: 'bundle-1', quantity: 2 },
    });

    // Only the genuinely loose line comes back as a CartItem.
    expect(tx.cartItem.create).toHaveBeenCalledTimes(1);
    expect(tx.cartItem.create).toHaveBeenCalledWith({
      data: { cartId: 'cart-1', productId: 'p-tea', variantId: undefined, quantity: 1 },
    });
    const restoredProducts = tx.cartItem.create.mock.calls.map(
      (c: unknown[]) => (c[0] as { data: { productId: string } }).data.productId
    );
    expect(restoredProducts).not.toContain('p-dates');
    expect(restoredProducts).not.toContain('p-honey');
  });

  it('clears any stale cart_bundles rows before restoring', async () => {
    await OrderService.rollbackForPaymentFailure('store-1', 'order-1', 'sess-1');
    expect(tx.cartBundle.deleteMany).toHaveBeenCalledWith({ where: { cartId: 'cart-1' } });
  });

  it('restores the components loose when the bundle row has since vanished', async () => {
    // Store-scoped existence check comes back empty.
    tx.bundle.findMany.mockResolvedValue([]);

    await OrderService.rollbackForPaymentFailure('store-1', 'order-1', 'sess-1');

    expect(tx.cartBundle.create).not.toHaveBeenCalled();
    const restoredProducts = tx.cartItem.create.mock.calls.map(
      (c: unknown[]) => (c[0] as { data: { productId: string } }).data.productId
    );
    // Nothing is lost: the customer keeps the goods, just unbundled — and
    // the compensating transaction still commits.
    expect(restoredProducts).toContain('p-dates');
    expect(restoredProducts).toContain('p-honey');
    expect(restoredProducts).toContain('p-tea');
  });

  it("scopes the bundle-existence check to the order's own store", async () => {
    await OrderService.rollbackForPaymentFailure('store-1', 'order-1', 'sess-1');
    expect(tx.bundle.findMany).toHaveBeenCalledWith({
      where: { id: { in: ['bundle-1'] }, storeId: 'store-1' },
      select: { id: true },
    });
  });

  it('writes no CartBundle for an order that contained no bundle', async () => {
    tx.order.findFirst.mockResolvedValue({
      id: 'order-2',
      storeId: 'store-1',
      status: 'pending',
      customerId: null,
      notes: null,
      payments: [],
      couponCode: null,
      items: [
        {
          id: 'oi-1',
          productId: 'p-tea',
          variantId: null,
          quantity: 2,
          bundleId: null,
          bundleGroupId: null,
        },
      ],
    });

    await OrderService.rollbackForPaymentFailure('store-1', 'order-2', 'sess-1');

    expect(tx.cartBundle.create).not.toHaveBeenCalled();
    expect(tx.cartItem.create).toHaveBeenCalledTimes(1);
  });
});
