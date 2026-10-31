/**
 * order-refunded fanout — reversal steps (money-integrity redesign, Task 2).
 *
 * Task 1 slimmed `OrderService.applyRefundEffects` to a thin dispatcher that
 * fires `order/refunded` with `{orderId, storeId, restoreInventory, notify}`
 * and DELETED the inline reversals. This test verifies the inventory-restore
 * reversal was rebuilt here as an idempotent `step.run`, guarded by the
 * per-order `return_stock` InventoryHistory marker written verbatim from the
 * old `applyRefundEffects` inner tx — moved (not just gated) into the fanout
 * so it survives past the request's 30s transaction window.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  orderFindUnique: vi.fn(),
  // Spy for the final claim-reversed step (stamps Order.refundReversedAt).
  orderUpdateMany: vi.fn().mockResolvedValue({ count: 1 }),
  // Issues 2246 / 2267: the partial arm marks its Return applied.
  returnUpdateMany: vi.fn().mockResolvedValue({ count: 1 }),
  storeFindUnique: vi.fn(),
  inventoryHistoryFindFirst: vi.fn(),
  inventoryHistoryCreate: vi.fn(),
  productUpdate: vi.fn(),
  productVariantUpdate: vi.fn(),
  queryRaw: vi.fn(),
  orderEventFindFirst: vi.fn(),
  // Partial-return markers (adversarial audit P1-2): the FULL restore path
  // now reads prior partial_return_restored orderEvents to subtract
  // already-restored quantities. Defaults to [] (no partial returns).
  orderEventFindMany: vi.fn().mockResolvedValue([]),
  orderEventCreate: vi.fn(),
  // #1935: a failed customer refund email releases the refund_notified claim.
  orderEventDeleteMany: vi.fn().mockResolvedValue({ count: 1 }),
  // issue 2138: the release now hands back ONE channel on the claim row.
  orderEventUpdate: vi.fn().mockResolvedValue({}),
  couponUpdateMany: vi.fn(),
  backorderLineUpdateMany: vi.fn(),
  reverseCommission: vi.fn(),
  reverseEarnedPointsFromOrder: vi.fn(),
  reverseRedeemedPointsFromOrder: vi.fn(),
  // Customer wallet (D1): the reverse-wallet-payment step.
  reverseOrderPayment: vi.fn(),
  // Task 4: order-refunded's new reconcile-warehouse-stock step calls this
  // for every order item. Mocked here (real impl is covered by
  // tests/integration/warehouse/reconcile-orders.test.ts against a real DB)
  // so this file stays a pure-unit, no-DB test of the fanout's own control
  // flow.
  reconcileWarehouseStockToAggregate: vi.fn().mockResolvedValue({ reconciled: false, diff: 0 }),
  invalidateStoreProductCaches: vi.fn().mockResolvedValue(undefined),
  loggerError: vi.fn(),
  sendOrderRefunded: vi.fn(),
  sendOrderCancelledNotCharged: vi.fn(),
  dispatch: vi.fn(),
  notifyAdminsOfRefund: vi.fn(),
  // Spy (not an inline passthrough) so tests can assert the FORCE-RLS side
  // effects actually run INSIDE a tenant context — the whole point of the fix.
  runInTenant: vi.fn((_s: string, fn: () => unknown) => fn()),
  // Issue 2359: tracks whether a withMoneyTx callback is currently open, so a
  // test can prove the cross-store bypass read never runs inside one.
  moneyTxDepth: { n: 0 },
  auditLogFindFirst: vi.fn(),
  bypassCalledInsideMoneyTx: vi.fn(),
}));

const txClient = {
  inventoryHistory: { findFirst: h.inventoryHistoryFindFirst, create: h.inventoryHistoryCreate },
  product: { update: h.productUpdate },
  productVariant: { update: h.productVariantUpdate },
  orderEvent: {
    findFirst: h.orderEventFindFirst,
    findMany: h.orderEventFindMany,
    create: h.orderEventCreate,
    deleteMany: h.orderEventDeleteMany,
    update: h.orderEventUpdate,
  },
  coupon: { updateMany: h.couponUpdateMany },
  // The whole-order restore reads the order's backorder lines for units
  // checkout never took (#2299); none here → the full quantity is restored.
  backorderLine: { findMany: vi.fn().mockResolvedValue([]) },
  $queryRaw: h.queryRaw,
};

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
// a Postgres store: the Durable Object money client is absent, so the job takes its unchanged Postgres path
vi.mock('@api/lib/repo-factory', async importOriginal => ({
  ...(await importOriginal<typeof import('@api/lib/repo-factory')>()),
  storeMoney: async () => null,
  storeDb: async () => ({}),
}));
vi.mock('@ebda/database', () => ({
  prisma: {
    order: { findUnique: h.orderFindUnique, updateMany: h.orderUpdateMany },
    return: { updateMany: h.returnUpdateMany },
    store: { findUnique: h.storeFindUnique },
    backorderLine: { updateMany: h.backorderLineUpdateMany },
  },
  runInTenantContext: h.runInTenant,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  withMoneyTx: async (_client: any, fn: (tx: typeof txClient) => unknown) => {
    h.moneyTxDepth.n++;
    try {
      return await fn(txClient);
    } finally {
      h.moneyTxDepth.n--;
    }
  },
}));

// The pre-cutover `order.admin_created` actor row carries no store, so it is answered by the
// `ebda_audit_log_exists` definer (`auditLogExists`); `auditLogFindFirst` stands for that row.
vi.mock('@api/lib/definer', () => ({
  auditLogExists: async () => {
    if (h.moneyTxDepth.n > 0) h.bypassCalledInsideMoneyTx();
    return !!(await h.auditLogFindFirst());
  },
}));

vi.mock('@api/services/email.service', () => ({
  EmailService: {
    sendOrderRefunded: h.sendOrderRefunded,
    sendOrderCancelledNotCharged: h.sendOrderCancelledNotCharged,
  },
}));
vi.mock('@api/services/notification-dispatcher.service', () => ({
  notificationDispatcher: { dispatch: h.dispatch },
}));
vi.mock('@api/services/onesignal.service', () => ({
  OneSignalService: { notifyAdminsOfRefund: h.notifyAdminsOfRefund },
}));
vi.mock('@api/services/affiliate.service', () => ({
  affiliateService: { reverseCommission: h.reverseCommission },
}));
vi.mock('@api/services/warehouse.service', () => ({
  WarehouseService: { reconcileWarehouseStockToAggregate: h.reconcileWarehouseStockToAggregate },
}));
vi.mock('@api/services/loyalty.service', () => ({
  LoyaltyService: {
    reverseEarnedPointsFromOrder: h.reverseEarnedPointsFromOrder,
    reverseRedeemedPointsFromOrder: h.reverseRedeemedPointsFromOrder,
  },
}));
vi.mock('@api/services/wallet.service', () => ({
  WalletService: { reverseOrderPayment: h.reverseOrderPayment },
}));
vi.mock('@api/lib/public-cache', () => ({
  invalidateStoreProductCaches: h.invalidateStoreProductCaches,
}));
vi.mock('@api/lib/inngest/client', () => ({ inngest: { createFunction: vi.fn(() => ({})) } }));
vi.mock('@api/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: h.loggerError },
}));

import { handleOrderRefunded } from '@api/lib/inngest/functions/order-refunded';

const stepStub = { run: async <T>(_id: string, fn: () => Promise<T>): Promise<T> => fn() };

// The canonical stock marker is present; the legacy rollback row (#1946) is
// not. The coupon step reads InventoryHistory too now, so a mock that answers
// EVERY findFirst with a row would read as a legacy rollback and skip it.
const canonicalStockMarkerOnly = (args: { where: Record<string, unknown> }) =>
  Promise.resolve(JSON.stringify(args.where).includes('return_stock') ? { id: 'marker-1' } : null);

const ORDER = {
  id: 'o1',
  storeId: 's1',
  orderNumber: 'ORD-1',
  // A REFUNDED order by default: money moved, so "Refund issued" is the
  // notice. The cancel-before-any-refund path (issue 1948) is exercised
  // explicitly below with status 'cancelled'.
  status: 'refunded',
  total: 5000,
  currency: 'EGP',
  locale: 'en',
  customer: { email: 'buyer@test.com', firstName: 'Sam', lastName: 'B' },
  payments: [],
  items: [
    { productId: 'p1', variantId: null, quantity: 2 },
    { productId: 'p2', variantId: 'v2', quantity: 1 },
  ],
  shippingAddress: {
    firstName: 'Sam',
    lastName: 'B',
    email: 'buyer@test.com',
    phone: '+96500000000',
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  h.orderFindUnique.mockResolvedValue(ORDER);
  h.storeFindUnique.mockResolvedValue({ name: 'Test Store' });
  h.queryRaw.mockImplementation(
    (strings: TemplateStringsArray, productId: string) =>
      Promise.resolve([{ id: productId, inventory: 10, track_inventory: true }])
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ) as any;
  h.orderEventFindFirst.mockResolvedValue(null);
  // vi.clearAllMocks() clears CALLS but not IMPLEMENTATIONS, so the
  // marker-present mock from the idempotency test leaks into every test that
  // runs after it and silently skips restore-inventory. Reset it explicitly.
  h.inventoryHistoryFindFirst.mockResolvedValue(null);
  h.reverseCommission.mockResolvedValue(null);
  h.reverseEarnedPointsFromOrder.mockResolvedValue(null);
  h.reverseRedeemedPointsFromOrder.mockResolvedValue(null);
  h.reverseOrderPayment.mockResolvedValue({ replayed: false });
  h.backorderLineUpdateMany.mockResolvedValue({ count: 0 });
  for (const fn of [
    h.sendOrderRefunded,
    h.dispatch,
    h.notifyAdminsOfRefund,
    h.productUpdate,
    h.orderEventCreate,
    h.couponUpdateMany,
    h.inventoryHistoryCreate,
  ])
    fn.mockResolvedValue(undefined);
  // The variant restore now READS BACK the post-increment inventory to derive
  // the ledger's previousStock (the product row is no longer touched for a
  // variant line, so it can no longer supply that number). v2 holds 40 after
  // the +1 restore.
  h.productVariantUpdate.mockResolvedValue({ inventory: 40 });
});

describe('order-refunded fanout — restore-inventory step', () => {
  it('restores inventory for both tracked items + writes 2 return_stock history rows', async () => {
    h.inventoryHistoryFindFirst.mockResolvedValue(null); // no marker yet

    await handleOrderRefunded('o1', 's1', true, true, stepStub);

    // ONE row per line. p1 has no variant, so its stock goes back on the
    // product row. p2's line names variant v2, so its stock goes back on the
    // VARIANT row and the parent product row is left alone — mirroring the
    // sale exactly. Until 2026-08-30 this incremented BOTH for p2, which is
    // half of what drove `products.inventory` out of step across the catalogue
    // (see docs/superpowers/plans/2026-08-30-variant-stock-drift.md).
    expect(h.productUpdate).toHaveBeenCalledTimes(1);
    expect(h.productUpdate).toHaveBeenCalledWith({
      where: { id: 'p1', storeId: 's1' },
      data: { inventory: { increment: 2 } },
    });
    expect(h.productUpdate).not.toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'p2' } })
    );
    expect(h.productVariantUpdate).toHaveBeenCalledTimes(1);
    expect(h.productVariantUpdate).toHaveBeenCalledWith({
      where: { id: 'v2' },
      data: { inventory: { increment: 1 } },
      select: { inventory: true },
    });

    expect(h.inventoryHistoryCreate).toHaveBeenCalledTimes(2);
    expect(h.inventoryHistoryCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        productId: 'p1',
        storeId: 's1',
        type: 'return_stock',
        quantity: 2,
        reference: 'o1',
      }),
    });
    expect(h.inventoryHistoryCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        productId: 'p2',
        storeId: 's1',
        type: 'return_stock',
        quantity: 1,
        reference: 'o1',
      }),
    });

    // The marker check ran INSIDE runInTenantContext(storeId).
    expect(h.runInTenant.mock.calls.some(c => c[0] === 's1')).toBe(true);
  });

  it('is idempotent — firing again with the return_stock marker present does NOT double-increment', async () => {
    h.inventoryHistoryFindFirst.mockResolvedValue({ id: 'marker-1' }); // marker already exists

    await handleOrderRefunded('o1', 's1', true, true, stepStub);

    expect(h.productUpdate).not.toHaveBeenCalled();
    expect(h.productVariantUpdate).not.toHaveBeenCalled();
    expect(h.inventoryHistoryCreate).not.toHaveBeenCalled();
  });

  it('skips the restore entirely when restoreInventory is false (e.g. backorder-line cancel)', async () => {
    h.inventoryHistoryFindFirst.mockResolvedValue(null);

    await handleOrderRefunded('o1', 's1', false, true, stepStub);

    expect(h.inventoryHistoryFindFirst).not.toHaveBeenCalled();
    expect(h.productUpdate).not.toHaveBeenCalled();
    expect(h.inventoryHistoryCreate).not.toHaveBeenCalled();
  });

  it('skips a non-tracked-inventory item but still restores the tracked one', async () => {
    h.inventoryHistoryFindFirst.mockResolvedValue(null);
    h.queryRaw.mockImplementation((_s: TemplateStringsArray, productId: string) =>
      Promise.resolve([{ id: productId, inventory: 10, track_inventory: productId === 'p1' }])
    ) as unknown as typeof h.queryRaw;

    await handleOrderRefunded('o1', 's1', true, true, stepStub);

    expect(h.productUpdate).toHaveBeenCalledTimes(1);
    expect(h.productUpdate).toHaveBeenCalledWith({
      where: { id: 'p1', storeId: 's1' },
      data: { inventory: { increment: 2 } },
    });
    expect(h.inventoryHistoryCreate).toHaveBeenCalledTimes(1);
  });
});

/**
 * Task 3 — coupon + affiliate + loyalty + backorder reversal steps. The
 * coupon reversal gets its OWN `coupon_reversed` orderEvent marker (NOT the
 * inventory `return_stock` marker) written atomically with the decrement in
 * the SAME `withMoneyTx`, so it also fires for restoreInventory:false /
 * no-tracked-inventory orders that never touch the stock marker.
 */
describe('order-refunded fanout — reverse-coupon step', () => {
  beforeEach(() => {
    h.orderFindUnique.mockResolvedValue({ ...ORDER, couponCode: 'SAVE10', customerId: 'c1' });
    h.inventoryHistoryFindFirst.mockImplementation(canonicalStockMarkerOnly); // inventory already restored — irrelevant here
  });

  it('decrements coupon usageCount exactly once across two fires and writes the coupon_reversed marker', async () => {
    h.orderEventFindFirst.mockResolvedValueOnce(null); // first fire: no marker yet
    await handleOrderRefunded('o1', 's1', true, true, stepStub);

    expect(h.couponUpdateMany).toHaveBeenCalledTimes(1);
    expect(h.couponUpdateMany).toHaveBeenCalledWith({
      where: { storeId: 's1', code: 'SAVE10', usageCount: { gt: 0 } },
      data: { usageCount: { decrement: 1 } },
    });
    expect(h.orderEventCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        storeId: 's1',
        orderId: 'o1',
        toStatus: 'coupon_reversed',
      }),
    });

    h.orderEventFindFirst.mockResolvedValueOnce({ id: 'marker-coupon' }); // second fire: marker exists
    await handleOrderRefunded('o1', 's1', true, true, stepStub);

    expect(h.couponUpdateMany).toHaveBeenCalledTimes(1); // still 1 — no double-decrement
    const couponMarkers = h.orderEventCreate.mock.calls.filter(
      ([arg]: [{ data: { toStatus: string } }]) => arg.data.toStatus === 'coupon_reversed'
    );
    expect(couponMarkers).toHaveLength(1); // marker written once
  });

  // Issue 2359: the pre-cutover admin-order lookup is a definer read —
  // a fresh $transaction on a second pool connection. It must run in its own
  // step BEFORE the coupon withMoneyTx opens, never inside it.
  it('pre-cutover admin order: looks up admin_created OUTSIDE the money tx and skips the decrement', async () => {
    h.orderFindUnique.mockResolvedValue({
      ...ORDER,
      couponCode: 'SAVE10',
      customerId: 'c1',
      createdAt: '2026-09-01T00:00:00Z',
    });
    h.auditLogFindFirst.mockResolvedValue({ id: 'audit-1' });
    const ids: string[] = [];
    const recordingStep = {
      run: async <T>(id: string, fn: () => Promise<T>): Promise<T> => {
        ids.push(id);
        return fn();
      },
    };

    await handleOrderRefunded('o1', 's1', true, true, recordingStep);

    expect(h.auditLogFindFirst).toHaveBeenCalledTimes(1);
    expect(h.bypassCalledInsideMoneyTx).not.toHaveBeenCalled();
    expect(ids.indexOf('admin-created-lookup')).toBeGreaterThanOrEqual(0);
    expect(ids.indexOf('admin-created-lookup')).toBeLessThan(ids.indexOf('reverse-coupon'));
    expect(h.couponUpdateMany).not.toHaveBeenCalled();
    expect(h.orderEventCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        toStatus: 'coupon_reversed',
        metadata: { skipped: 'admin_order_never_reserved' },
      }),
    });
  });

  it('pre-cutover checkout order (no admin_created row) still decrements once', async () => {
    h.orderFindUnique.mockResolvedValue({
      ...ORDER,
      couponCode: 'SAVE10',
      customerId: 'c1',
      createdAt: '2026-09-01T00:00:00Z',
    });
    h.auditLogFindFirst.mockResolvedValue(null);

    await handleOrderRefunded('o1', 's1', true, true, stepStub);

    expect(h.bypassCalledInsideMoneyTx).not.toHaveBeenCalled();
    expect(h.couponUpdateMany).toHaveBeenCalledTimes(1);
  });

  it('post-cutover order never runs the admin_created lookup', async () => {
    h.orderFindUnique.mockResolvedValue({
      ...ORDER,
      couponCode: 'SAVE10',
      customerId: 'c1',
      createdAt: '2026-10-01T00:00:00Z',
    });

    await handleOrderRefunded('o1', 's1', true, true, stepStub);

    expect(h.auditLogFindFirst).not.toHaveBeenCalled();
    expect(h.couponUpdateMany).toHaveBeenCalledTimes(1);
  });

  it('skips coupon reversal entirely when the order has no couponCode', async () => {
    h.orderFindUnique.mockResolvedValue({ ...ORDER, couponCode: null, customerId: null });

    await handleOrderRefunded('o1', 's1', true, true, stepStub);

    expect(h.couponUpdateMany).not.toHaveBeenCalled();
    expect(h.orderEventCreate).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ toStatus: 'coupon_reversed' }) })
    );
  });
});

describe('order-refunded fanout — affiliate/loyalty/backorder reversal steps', () => {
  beforeEach(() => {
    h.inventoryHistoryFindFirst.mockResolvedValue({ id: 'marker-1' });
  });

  it('calls affiliateService.reverseCommission in-context', async () => {
    h.orderFindUnique.mockResolvedValue({ ...ORDER, couponCode: null, customerId: null });

    await handleOrderRefunded('o1', 's1', true, true, stepStub);

    expect(h.reverseCommission).toHaveBeenCalledWith('s1', 'o1');
    expect(h.runInTenant.mock.calls.some(c => c[0] === 's1')).toBe(true);
  });

  it('calls both loyalty reversal methods in-context when order.customerId is set', async () => {
    h.orderFindUnique.mockResolvedValue({ ...ORDER, couponCode: null, customerId: 'c1' });

    await handleOrderRefunded('o1', 's1', true, true, stepStub);

    expect(h.reverseEarnedPointsFromOrder).toHaveBeenCalledWith('s1', 'o1');
    expect(h.reverseRedeemedPointsFromOrder).toHaveBeenCalledWith('s1', 'o1');
  });

  it('skips loyalty reversal for guest orders (no customerId)', async () => {
    h.orderFindUnique.mockResolvedValue({ ...ORDER, couponCode: null, customerId: null });

    await handleOrderRefunded('o1', 's1', true, true, stepStub);

    expect(h.reverseEarnedPointsFromOrder).not.toHaveBeenCalled();
    expect(h.reverseRedeemedPointsFromOrder).not.toHaveBeenCalled();
  });

  it('cancels open backorder lines for the order', async () => {
    h.orderFindUnique.mockResolvedValue({ ...ORDER, couponCode: null, customerId: null });

    await handleOrderRefunded('o1', 's1', true, true, stepStub);

    expect(h.backorderLineUpdateMany).toHaveBeenCalledWith({
      where: { storeId: 's1', orderItem: { orderId: 'o1' }, fulfilledAt: null, cancelledAt: null },
      data: expect.objectContaining({ cancelledReason: 'Order refunded' }),
    });
  });
});

/**
 * Task-2 carry-forward fix (from Task 3 review): both money txns (inventory
 * restore + coupon reversal) must lock the order row FIRST — before either
 * reads its own marker — so two concurrent `order/refunded` deliveries for
 * the same order serialize instead of both passing the marker check before
 * either commits (double-apply).
 */
describe('order-refunded fanout — order-level FOR UPDATE lock ordering', () => {
  it('issues the order-level FOR UPDATE lock before the return_stock marker read in restore-inventory', async () => {
    const callOrder: string[] = [];
    h.orderFindUnique.mockResolvedValue({ ...ORDER, couponCode: null, customerId: null });
    h.queryRaw.mockImplementation((strings: TemplateStringsArray, ...args: unknown[]) => {
      const sql = strings.join('');
      if (sql.includes('public.orders')) {
        callOrder.push('order-lock');
        return Promise.resolve([{ id: args[0] }]);
      }
      return Promise.resolve([{ id: args[0], inventory: 10, track_inventory: true }]);
    });
    h.inventoryHistoryFindFirst.mockImplementation(() => {
      callOrder.push('stock-marker-read');
      return Promise.resolve(null);
    });

    await handleOrderRefunded('o1', 's1', true, true, stepStub);

    expect(callOrder[0]).toBe('order-lock');
    expect(callOrder.indexOf('order-lock')).toBeLessThan(callOrder.indexOf('stock-marker-read'));
  });

  it('issues the order-level FOR UPDATE lock before the coupon_reversed marker read in reverse-coupon', async () => {
    const callOrder: string[] = [];
    h.orderFindUnique.mockResolvedValue({ ...ORDER, couponCode: 'SAVE10', customerId: null });
    h.inventoryHistoryFindFirst.mockResolvedValue({ id: 'marker-1' }); // restore-inventory skips its work, but still locks first
    h.queryRaw.mockImplementation((strings: TemplateStringsArray, ...args: unknown[]) => {
      const sql = strings.join('');
      if (sql.includes('public.orders')) {
        callOrder.push('order-lock');
      }
      return Promise.resolve([{ id: args[0] }]);
    });
    h.orderEventFindFirst.mockImplementation((args: { where: { toStatus?: string } }) => {
      callOrder.push(`${args?.where?.toStatus}-read`);
      return Promise.resolve(null);
    });

    await handleOrderRefunded('o1', 's1', true, true, stepStub);

    // One order-lock per withMoneyTx: restore-inventory, reverse-coupon and
    // the refund-notification claim = 3.
    expect(callOrder.filter(c => c === 'order-lock').length).toBe(3);
    // Each marker read is immediately preceded by its own tx's order lock.
    for (const read of ['coupon_reversed-read', 'refund_notified-read']) {
      const idx = callOrder.indexOf(read);
      expect(idx, read).toBeGreaterThan(0);
      expect(callOrder[idx - 1], read).toBe('order-lock');
    }
  });
});

/**
 * Item 5 data-integrity, Task 4 — the reconcile-warehouse-stock step. Reconciles
 * every order item's SKU so `SUM(WarehouseStock)` catches up with the
 * just-restored aggregate; the real DB-backed proof lives in
 * tests/integration/warehouse/reconcile-orders.test.ts — this file only
 * proves the fanout's own control flow (called for every item, runs even
 * when nothing was restored).
 *
 * Fix wave 1 (money-integrity gate): this step was moved from right after
 * restore-inventory to right after the LAST money reversal (cancel-backorders)
 * and immediately before claim-reversed, and made best-effort — it now
 * SWALLOWS a failure instead of propagating it, because `WarehouseStock` is
 * an admin-view-only shadow already backstopped by the daily
 * `backfillReconcileAll` sweep, and must never gate a money reversal or the
 * `refundReversedAt` completion stamp. See the two tests below (in the
 * claim-reversed describe block) proving the refund still completes and
 * stamps `refundReversedAt` even when every reconcile call rejects.
 */
describe('order-refunded fanout — reconcile-warehouse-stock step (Task 4)', () => {
  it('reconciles every order item under runInTenantContext(storeId)', async () => {
    await handleOrderRefunded('o1', 's1', true, true, stepStub);

    expect(h.reconcileWarehouseStockToAggregate).toHaveBeenCalledWith('s1', 'p1', null);
    expect(h.reconcileWarehouseStockToAggregate).toHaveBeenCalledWith('s1', 'p2', 'v2');
    expect(h.runInTenant.mock.calls.some(c => c[0] === 's1')).toBe(true);
  });

  it('still reconciles even when restoreInventory is false (unconditional, not gated on the restore)', async () => {
    await handleOrderRefunded('o1', 's1', false, true, stepStub);

    expect(h.reconcileWarehouseStockToAggregate).toHaveBeenCalledWith('s1', 'p1', null);
    expect(h.reconcileWarehouseStockToAggregate).toHaveBeenCalledWith('s1', 'p2', 'v2');
  });

  it('a reconcile rejection is swallowed (logged, NOT propagated) — the refund resolves', async () => {
    h.reconcileWarehouseStockToAggregate.mockRejectedValueOnce(new Error('reconcile down'));

    await expect(handleOrderRefunded('o1', 's1', true, true, stepStub)).resolves.not.toThrow();

    expect(h.loggerError).toHaveBeenCalledWith(
      expect.objectContaining({
        orderId: 'o1',
        storeId: 's1',
        productId: 'p1',
        variantId: null,
        err: expect.any(Error),
      }),
      expect.stringContaining('reconcile-warehouse-stock')
    );
  });

  it('one bad SKU does not abort reconcile for the rest of the order (per-SKU isolation)', async () => {
    h.reconcileWarehouseStockToAggregate.mockImplementation((_s: string, productId: string) => {
      if (productId === 'p1') return Promise.reject(new Error('p1 reconcile boom'));
      return Promise.resolve({ reconciled: false, diff: 0 });
    });

    await handleOrderRefunded('o1', 's1', true, true, stepStub);

    // p1 failed, but p2 was still attempted — proving the loop's per-SKU
    // try/catch didn't bail out after the first failure.
    expect(h.reconcileWarehouseStockToAggregate).toHaveBeenCalledWith('s1', 'p1', null);
    expect(h.reconcileWarehouseStockToAggregate).toHaveBeenCalledWith('s1', 'p2', 'v2');
  });
});

/**
 * Task 4 — two-tier failure policy. Reversals ALWAYS run and THROW (Inngest
 * retries → dead-letters via alerts-failure-watch on exhaustion). The
 * notification block (email/dispatcher/push) is gated on `notify` AND stays
 * inside the swallowing Promise.allSettled. Without the `notify` gate, every
 * unpaid cancel (notify:false, restoreInventory:true) would still email/push
 * a "Refund issued" notification — re-introducing the spurious-notification
 * bug `order.service.ts` comments say was previously fixed.
 */
describe('order-refunded fanout — two-tier failure policy (Task 4)', () => {
  beforeEach(() => {
    h.orderFindUnique.mockResolvedValue({ ...ORDER, couponCode: null, customerId: null });
    h.inventoryHistoryFindFirst.mockImplementation(canonicalStockMarkerOnly); // reversals no-op/skip cheaply
  });

  it('notify:false (unpaid cancel) — reversals run but NONE of the 3 notification steps fire', async () => {
    await handleOrderRefunded('o1', 's1', true, false, stepStub);

    // Reversals still ran.
    expect(h.reverseCommission).toHaveBeenCalledWith('s1', 'o1');
    expect(h.backorderLineUpdateMany).toHaveBeenCalled();

    // Notifications did NOT run.
    expect(h.sendOrderRefunded).not.toHaveBeenCalled();
    expect(h.dispatch).not.toHaveBeenCalled();
    expect(h.notifyAdminsOfRefund).not.toHaveBeenCalled();
  });

  it('notify:true — notifications run', async () => {
    await handleOrderRefunded('o1', 's1', true, true, stepStub);

    expect(h.sendOrderRefunded).toHaveBeenCalledTimes(1);
    expect(h.dispatch).toHaveBeenCalledTimes(1);
    expect(h.notifyAdminsOfRefund).toHaveBeenCalledTimes(1);
  });

  it('a reversal step throwing — handler REJECTS and notifications did NOT run', async () => {
    h.orderFindUnique.mockResolvedValue({ ...ORDER, couponCode: 'SAVE10', customerId: null });
    h.couponUpdateMany.mockRejectedValue(new Error('db down'));

    await expect(handleOrderRefunded('o1', 's1', true, true, stepStub)).rejects.toThrow('db down');

    expect(h.sendOrderRefunded).not.toHaveBeenCalled();
    expect(h.dispatch).not.toHaveBeenCalled();
    expect(h.notifyAdminsOfRefund).not.toHaveBeenCalled();
  });

  it('the admin push throwing — handler RESOLVES (swallowed)', async () => {
    h.notifyAdminsOfRefund.mockRejectedValue(new Error('onesignal down'));

    await expect(handleOrderRefunded('o1', 's1', true, true, stepStub)).resolves.not.toThrow();

    expect(h.sendOrderRefunded).toHaveBeenCalledTimes(1);
    expect(h.dispatch).toHaveBeenCalledTimes(1);
    expect(h.orderEventDeleteMany).not.toHaveBeenCalled();
  });

  // #1935 — the refund_notified claim is committed before the sends. A
  // swallowed customer-email failure used to end the run green with the claim
  // held, so nothing (not a redelivery, not the notify:false stuck-sweep)
  // could ever tell the customer their refund was issued.
  it('the customer email failing — the rest still runs, then the claim is released and the run FAILS', async () => {
    h.sendOrderRefunded.mockRejectedValue(new Error('enqueue failed'));
    // First read (the claim): no row yet. Later read (the release): the row.
    let claimReads = 0;
    h.orderEventFindFirst.mockImplementation((args: { where: { toStatus?: string } }) =>
      Promise.resolve(
        args?.where?.toStatus === 'refund_notified' && claimReads++ > 0
          ? { id: 'claim-1', metadata: {} }
          : null
      )
    );
    const order: string[] = [];
    const recordingStep = {
      run: async <T>(id: string, fn: () => Promise<T>): Promise<T> => {
        order.push(id);
        return fn();
      },
    };

    await expect(handleOrderRefunded('o1', 's1', true, true, recordingStep)).rejects.toThrow(
      /customer refund email for order o1 was not sent/
    );

    // The other notifications and every reversal still ran …
    expect(h.dispatch).toHaveBeenCalledTimes(1);
    expect(h.notifyAdminsOfRefund).toHaveBeenCalledTimes(1);
    expect(h.orderUpdateMany).toHaveBeenCalledTimes(1); // claim-reversed stamp
    // … and ONLY the email channel was released (issue 2138 / issue 2135),
    // after the completion stamp, so a replay notifies the customer and
    // nothing else. The claim row is never deleted.
    expect(h.orderEventDeleteMany).not.toHaveBeenCalled();
    expect(h.orderEventUpdate).toHaveBeenCalledWith({
      where: { id: 'claim-1', storeId: 's1' },
      data: { metadata: { released: ['email'] } },
    });
    expect(order.indexOf('release-refund-notification-claim')).toBeGreaterThan(
      order.indexOf('claim-reversed')
    );
  });

  it('a replay after an email-only release sends the email and NOT the dispatch or push again', async () => {
    h.orderEventFindFirst.mockImplementation((args: { where: { toStatus?: string } }) =>
      Promise.resolve(
        args?.where?.toStatus === 'refund_notified'
          ? { id: 'claim-1', metadata: { released: ['email'] } }
          : null
      )
    );

    await handleOrderRefunded('o1', 's1', true, true, stepStub);

    expect(h.sendOrderRefunded).toHaveBeenCalledTimes(1);
    expect(h.dispatch).not.toHaveBeenCalled();
    expect(h.notifyAdminsOfRefund).not.toHaveBeenCalled();
    // …and the released channel is re-claimed.
    expect(h.orderEventUpdate).toHaveBeenCalledWith({
      where: { id: 'claim-1', storeId: 's1' },
      data: { metadata: { released: [] } },
    });
  });

  it('a claim row with no released list (every row written before issue 2138) sends nothing', async () => {
    h.orderEventFindFirst.mockImplementation((args: { where: { toStatus?: string } }) =>
      Promise.resolve(
        args?.where?.toStatus === 'refund_notified' ? { id: 'claim-1', metadata: {} } : null
      )
    );

    await handleOrderRefunded('o1', 's1', true, true, stepStub);

    expect(h.sendOrderRefunded).not.toHaveBeenCalled();
    expect(h.dispatch).not.toHaveBeenCalled();
    expect(h.notifyAdminsOfRefund).not.toHaveBeenCalled();
  });

  it('a partial return whose email fails is not claimed, so nothing is released, but the run still fails', async () => {
    h.sendOrderRefunded.mockRejectedValue(new Error('enqueue failed'));
    h.orderFindUnique.mockResolvedValue({
      ...ORDER,
      couponCode: null,
      customerId: null,
      items: [{ id: 'i1', productId: 'p1', variantId: null, quantity: 2 }],
    });
    h.orderEventFindFirst.mockResolvedValue(null);
    await expect(
      handleOrderRefunded('o1', 's1', true, true, stepStub, {
        items: [{ orderItemId: 'i1', quantity: 1 }],
        refundKey: 'ret-1',
        refundAmount: 1000,
      })
    ).rejects.toThrow(/was not sent/);
    expect(h.orderEventDeleteMany).not.toHaveBeenCalled();
  });
});

describe('order-refunded fanout — a partial announces only its OWN amount (issue 2274)', () => {
  beforeEach(() => {
    h.orderFindUnique.mockResolvedValue({
      ...ORDER,
      total: 50_000,
      couponCode: null,
      customerId: null,
      items: [{ id: 'i1', productId: 'p1', variantId: null, quantity: 2 }],
    });
    h.orderEventFindFirst.mockResolvedValue(null);
    h.sendOrderRefunded.mockResolvedValue(undefined);
  });
  const partial = (refundAmount: number | undefined) => ({
    items: [{ orderItemId: 'i1', quantity: 1 }],
    refundKey: 'ret-2274',
    refundAmount,
  });

  it('refundAmount 0 notifies NOBODY — never falls through to the order total', async () => {
    await handleOrderRefunded('o1', 's1', true, true, stepStub, partial(0));
    expect(h.sendOrderRefunded).not.toHaveBeenCalled();
    expect(h.dispatch).not.toHaveBeenCalled();
    expect(h.notifyAdminsOfRefund).not.toHaveBeenCalled();
  });

  it('an absent refundAmount notifies nobody either', async () => {
    await handleOrderRefunded('o1', 's1', true, true, stepStub, partial(undefined));
    expect(h.sendOrderRefunded).not.toHaveBeenCalled();
  });

  it('marks its OWN Return reversal-applied, idempotently, and never claims the order', async () => {
    await handleOrderRefunded('o1', 's1', true, true, stepStub, partial(1_250));
    expect(h.returnUpdateMany).toHaveBeenCalledWith({
      where: { id: 'ret-2274', storeId: 's1', reversalAppliedAt: null },
      data: { reversalAppliedAt: expect.any(Date) },
    });
    expect(h.orderUpdateMany).not.toHaveBeenCalled();
  });

  it('a positive partial amount is announced as-is', async () => {
    await handleOrderRefunded('o1', 's1', true, true, stepStub, partial(1_250));
    expect(h.sendOrderRefunded).toHaveBeenCalledTimes(1);
    const emailData = h.sendOrderRefunded.mock.calls[0].find(
      (a: unknown) => typeof a === 'object' && a !== null && 'refundAmount' in a
    );
    expect(emailData).toMatchObject({ refundAmount: 1_250 });
  });
});

/**
 * Issue 2274, backorder shape — a single backorder LINE cancel (restoreInventory
 * false, refundKey `backorder:<lineId>`) whose allocation is 0 must not tell
 * the customer anything. Complements the generic partial cases above.
 */
describe('order-refunded fanout — zero-amount backorder line cancel (issue 2274)', () => {
  it('never emails the order total for a backorder cancel that refunds nothing', async () => {
    h.sendOrderRefunded.mockReset().mockResolvedValue(undefined);
    h.orderFindUnique.mockResolvedValue({
      ...ORDER,
      couponCode: null,
      customerId: null,
      items: [{ id: 'i1', productId: 'p1', variantId: null, quantity: 2 }],
    });
    h.orderEventFindFirst.mockResolvedValue(null);
    await handleOrderRefunded('o1', 's1', false, true, stepStub, {
      items: [{ orderItemId: 'i1', quantity: 1 }],
      refundKey: 'backorder:bo1',
      refundAmount: 0,
    });
    expect(h.sendOrderRefunded).not.toHaveBeenCalled();
  });
});

describe('order-refunded fanout — claim-reversed step', () => {
  // These two cases are the entire reason Order.refundReversedAt exists rather
  // than the sweep keying on InventoryHistory marker-absence. Both legitimately
  // restore no stock and write no marker, so a marker-based sweep would re-fire
  // them every 5 minutes forever — and for the backorder case that would invent
  // stock that was never reserved.
  it('stamps the claim even when restoreInventory is false (backorder-line cancel)', async () => {
    await handleOrderRefunded('o1', 's1', false, false, stepStub);
    expect(h.orderUpdateMany).toHaveBeenCalledTimes(1);
    expect(h.orderUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'o1', refundReversedAt: null }),
      })
    );
    // and no stock moved
    expect(h.productUpdate).not.toHaveBeenCalled();
  });

  // Issue 2132: an unarmed (restoreInventory:false) event must only close an
  // UNARMED claim — never one a dropped stock-restoring event armed.
  it('restoreInventory:false only matches an UNARMED claim', async () => {
    await handleOrderRefunded('o1', 's1', false, false, stepStub);
    expect(h.orderUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ refundReversalRequestedAt: null }),
      })
    );
  });

  it('restoreInventory:true closes the armed claim (no requestedAt filter)', async () => {
    await handleOrderRefunded('o1', 's1', true, false, stepStub);
    const where = h.orderUpdateMany.mock.calls.at(-1)?.[0]?.where;
    expect(where).toMatchObject({ id: 'o1', refundReversedAt: null });
    expect(where).not.toHaveProperty('refundReversalRequestedAt');
  });

  it('stamps the claim when every product is untracked (no history row written)', async () => {
    h.queryRaw.mockImplementation(
      (_s: TemplateStringsArray, productId: string) =>
        Promise.resolve([{ id: productId, inventory: 10, track_inventory: false }])
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ) as any;
    await handleOrderRefunded('o1', 's1', true, false, stepStub);
    expect(h.inventoryHistoryCreate).not.toHaveBeenCalled();
    expect(h.orderUpdateMany).toHaveBeenCalledTimes(1);
  });

  // The claim must be LAST. If it were stamped before the reversals, a failing
  // reversal would leave a half-reversed order marked done — permanently hidden
  // from refund-reversal-stuck-sweep, which is the only thing that would catch it.
  it('does NOT stamp the claim when a reversal step throws', async () => {
    h.productUpdate.mockRejectedValue(new Error('db down'));
    let threw: unknown = null;
    try {
      await handleOrderRefunded('o1', 's1', true, false, stepStub);
    } catch (e) {
      threw = e;
    }
    // The reversal must propagate so Inngest retries the event.
    expect(threw).toBeInstanceOf(Error);
    expect((threw as Error).message).toBe('db down');
    // And the order must stay unclaimed, so the sweep can still see it.
    expect(h.orderUpdateMany).not.toHaveBeenCalled();
    expect(h.orderUpdateMany).not.toHaveBeenCalled();
  });

  /**
   * Fix wave 1 (money-integrity gate) — THE core invariant this fix restores.
   * reconcile-warehouse-stock is a non-money, admin-view-only shadow sync
   * backstopped by the daily sweep; a PERSISTENT failure there (e.g. an
   * exhausted internal retry, a withMoneyTx P2028 timeout) must never abort
   * the run before the money reversals or the completion stamp. Before this
   * fix, this step sat BEFORE the reversals and threw on failure — a
   * persistent failure here would have aborted the function, left every
   * money reversal below it un-run, and left refundReversedAt permanently
   * null (causing refund-reversal-stuck-sweep to re-fire this event forever).
   */
  it('a reconcile failure does NOT block money reversals or the claim-reversed stamp', async () => {
    h.orderFindUnique.mockResolvedValue({ ...ORDER, couponCode: 'SAVE10', customerId: 'c1' });
    h.reconcileWarehouseStockToAggregate.mockRejectedValue(new Error('reconcile permanently down'));

    await expect(handleOrderRefunded('o1', 's1', true, true, stepStub)).resolves.not.toThrow();

    // Every money reversal ran to completion.
    expect(h.couponUpdateMany).toHaveBeenCalledTimes(1);
    expect(h.reverseCommission).toHaveBeenCalledWith('s1', 'o1');
    expect(h.reverseEarnedPointsFromOrder).toHaveBeenCalledWith('s1', 'o1');
    expect(h.reverseRedeemedPointsFromOrder).toHaveBeenCalledWith('s1', 'o1');
    expect(h.backorderLineUpdateMany).toHaveBeenCalled();

    // The completion claim was still stamped despite reconcile failing.
    expect(h.orderUpdateMany).toHaveBeenCalledTimes(1);
    expect(h.orderUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'o1', refundReversedAt: null }),
        data: expect.objectContaining({ refundReversedAt: expect.any(Date) }),
      })
    );

    // The failure was logged, not swallowed silently.
    expect(h.loggerError).toHaveBeenCalledWith(
      expect.objectContaining({ orderId: 'o1', storeId: 's1' }),
      expect.stringContaining('reconcile-warehouse-stock')
    );
  });

  // Guards the re-fire path the sweep depends on: a swept re-send must not
  // overwrite the original completion timestamp.
  it('is idempotent — the claim is scoped to refundReversedAt: null', async () => {
    h.orderUpdateMany.mockResolvedValue({ count: 0 });
    await handleOrderRefunded('o1', 's1', true, false, stepStub);
    expect(h.orderUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ refundReversedAt: null }),
      })
    );
  });
});

describe('order-refunded fanout — reverse-wallet-payment step (D1 customer wallet)', () => {
  it('puts the wallet spend back on a whole-order cancel/refund, inside a tenant context', async () => {
    h.orderFindUnique.mockResolvedValue({ ...ORDER, customerId: 'c1', walletAmount: 3500 });
    await handleOrderRefunded('o1', 's1', true, true, stepStub);
    expect(h.reverseOrderPayment).toHaveBeenCalledTimes(1);
    expect(h.reverseOrderPayment).toHaveBeenCalledWith({ storeId: 's1', orderId: 'o1' });
    expect(h.runInTenant).toHaveBeenCalledWith('s1', expect.any(Function));
  });

  it('does nothing for an order that never spent from a wallet (every order before D1)', async () => {
    h.orderFindUnique.mockResolvedValue({ ...ORDER, walletAmount: 0 });
    await handleOrderRefunded('o1', 's1', true, true, stepStub);
    expect(h.reverseOrderPayment).not.toHaveBeenCalled();
  });

  it('never reverses on a PARTIAL return — the customer kept the rest of the order', async () => {
    h.orderFindUnique.mockResolvedValue({ ...ORDER, walletAmount: 3500 });
    await handleOrderRefunded('o1', 's1', true, true, stepStub, {
      items: [{ orderItemId: 'oi1', quantity: 1 }],
      refundKey: 'r1',
    });
    expect(h.reverseOrderPayment).not.toHaveBeenCalled();
  });

  it('never reverses when the caller opted out (backorder single-line cancel)', async () => {
    h.orderFindUnique.mockResolvedValue({ ...ORDER, walletAmount: 3500 });
    await handleOrderRefunded('o1', 's1', false, true, stepStub, undefined, false);
    expect(h.reverseOrderPayment).not.toHaveBeenCalled();
  });

  it('throws (so Inngest retries) when the reversal fails, before the completion stamp', async () => {
    h.orderFindUnique.mockResolvedValue({ ...ORDER, walletAmount: 3500 });
    h.reverseOrderPayment.mockRejectedValueOnce(new Error('db down'));
    await expect(handleOrderRefunded('o1', 's1', true, true, stepStub)).rejects.toThrow('db down');
    expect(h.orderUpdateMany).not.toHaveBeenCalled();
  });
});

describe('order-refunded fanout — product cache invalidation (bundles decisions doc)', () => {
  it('busts the store product caches after restoring stock, so availability is not stale', async () => {
    await handleOrderRefunded('o1', 's1', true, true, stepStub);
    expect(h.invalidateStoreProductCaches).toHaveBeenCalledWith('s1');
  });

  it('does not bust caches when no stock was restored (restoreInventory false)', async () => {
    await handleOrderRefunded('o1', 's1', false, true, stepStub);
    expect(h.invalidateStoreProductCaches).not.toHaveBeenCalled();
  });

  it('a cache failure is swallowed — the refund still resolves', async () => {
    h.invalidateStoreProductCaches.mockRejectedValueOnce(new Error('redis down'));
    await expect(handleOrderRefunded('o1', 's1', true, true, stepStub)).resolves.not.toThrow();
  });
});

describe('order-refunded fanout — "Refund issued" goes out once per order (PR #770)', () => {
  const markerFor = (toStatus: string, present: boolean) =>
    h.orderEventFindFirst.mockImplementation((args: { where: { toStatus?: string } }) =>
      Promise.resolve(args?.where?.toStatus === toStatus && present ? { id: 'm' } : null)
    );

  it('sends the refund email and claims refund_notified when nobody was told yet', async () => {
    markerFor('refund_notified', false);
    await handleOrderRefunded('o1', 's1', true, true, stepStub);
    expect(h.sendOrderRefunded).toHaveBeenCalledTimes(1);
    expect(h.orderEventCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ toStatus: 'refund_notified' }) })
    );
  });

  it('stays silent when the order was already told (cancelled while paid, then refunded)', async () => {
    markerFor('refund_notified', true);
    await handleOrderRefunded('o1', 's1', true, true, stepStub);
    expect(h.sendOrderRefunded).not.toHaveBeenCalled();
    expect(h.notifyAdminsOfRefund).not.toHaveBeenCalled();
  });

  it('never claims or sends when notify is false (an unpaid cancel)', async () => {
    markerFor('refund_notified', false);
    await handleOrderRefunded('o1', 's1', true, false, stepStub);
    expect(h.sendOrderRefunded).not.toHaveBeenCalled();
    expect(h.orderEventCreate).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ toStatus: 'refund_notified' }) })
    );
  });
});

// #1946 — rollbackForPaymentFailure wrote its stock restore as an
// `adjustment` row (and no coupon_reversed event) until 2026-09-25. An order
// rolled back before then and refunded afterwards (cancelled → refunded is
// legal since PR #770) must not get its stock or its coupon back twice.
describe('order-refunded fanout — orders rolled back before the canonical markers (#1946)', () => {
  const legacyRowOnly = (args: { where: Record<string, unknown> }) =>
    Promise.resolve(
      JSON.stringify(args.where).includes('Order rollback — payment step failed')
        ? { id: 'legacy-rollback-row' }
        : null
    );

  beforeEach(() => {
    h.orderFindUnique.mockResolvedValue({ ...ORDER, couponCode: 'SAVE10', customerId: null });
    h.inventoryHistoryFindFirst.mockImplementation(legacyRowOnly);
    h.orderEventFindFirst.mockResolvedValue(null); // no coupon_reversed event: legacy shape
  });

  it('does not restore stock a second time', async () => {
    await handleOrderRefunded('o1', 's1', true, true, stepStub);
    expect(h.productUpdate).not.toHaveBeenCalled();
    expect(h.productVariantUpdate).not.toHaveBeenCalled();
    expect(h.inventoryHistoryCreate).not.toHaveBeenCalled();
  });

  it('does not release the coupon a second time', async () => {
    await handleOrderRefunded('o1', 's1', true, true, stepStub);
    expect(h.couponUpdateMany).not.toHaveBeenCalled();
  });

  it('matches the legacy row by its exact server-written shape, scoped to the order and store', async () => {
    await handleOrderRefunded('o1', 's1', true, true, stepStub);
    expect(h.inventoryHistoryFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          reference: 'o1',
          storeId: 's1',
          type: 'adjustment',
          reason: 'Order rollback — payment step failed',
        },
      })
    );
  });

  it('an ordinary adjustment row is not mistaken for a rollback (control)', async () => {
    h.inventoryHistoryFindFirst.mockResolvedValue(null);
    await handleOrderRefunded('o1', 's1', true, true, stepStub);
    expect(h.productUpdate).toHaveBeenCalled();
    expect(h.couponUpdateMany).toHaveBeenCalledTimes(1);
  });
});

/**
 * Issue 1948 (owner decision 2026-10-01): a paid order CANCELLED before any
 * refund moved gets "Your order was cancelled. You were not charged." — not
 * "Refund issued" — and does NOT spend the once-per-order refund claim, so the
 * real settlement later still tells the customer. Mutation-proof: dropping
 * the `cancelNoticeOnly` gate sends "Refund issued" at the cancel again and
 * reddens the first case.
 */
describe('order-refunded fanout — cancel before any refund moved (issue 1948)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.inventoryHistoryFindFirst.mockImplementation(canonicalStockMarkerOnly);
    h.orderEventFindFirst.mockResolvedValue(null);
  });

  const createdMarkers = () =>
    h.orderEventCreate.mock.calls.map(c => (c[0] as { data: { toStatus: string } }).data.toStatus);

  it('sends the cancellation notice, not "Refund issued", and keeps the refund claim unspent', async () => {
    h.orderFindUnique.mockResolvedValue({
      ...ORDER,
      status: 'cancelled',
      payments: [{ refundedAmount: 0, provider: 'paymob', metadata: {} }],
      couponCode: null,
      customerId: null,
    });

    await handleOrderRefunded('o1', 's1', true, true, stepStub);

    expect(h.sendOrderCancelledNotCharged).toHaveBeenCalledTimes(1);
    expect(h.sendOrderCancelledNotCharged.mock.calls[0][1]).toMatchObject({
      orderNumber: 'ORD-1',
      customerEmail: 'buyer@test.com',
    });
    expect(h.sendOrderRefunded).not.toHaveBeenCalled();
    expect(h.dispatch).not.toHaveBeenCalled();
    expect(h.notifyAdminsOfRefund).not.toHaveBeenCalled();
    expect(createdMarkers()).toContain('cancel_notified');
    expect(createdMarkers()).not.toContain('refund_notified');
  });

  // Coordinator correction to 1948: the notice must be TRUE for the case.
  it.each([
    [
      'a captured card payment → refund pending',
      'paid',
      [{ provider: 'paymob', status: 'completed', refundedAmount: 0, metadata: {} }],
      true,
    ],
    [
      'an unpaid order → not charged',
      'unpaid',
      [{ provider: 'paymob', status: 'pending', refundedAmount: 0, metadata: {} }],
      false,
    ],
    [
      'an auth-only / voided payment → not charged',
      'unpaid',
      [{ provider: 'kashier', status: 'cancelled', refundedAmount: 0, metadata: {} }],
      false,
    ],
    // PR 2335 audit P1: COD whose cash was COLLECTED (mark-paid → order paid,
    // payment completed) is owed a refund — never "not charged".
    [
      'cash on delivery, cash collected → refund pending',
      'paid',
      [{ provider: 'cod', status: 'completed', refundedAmount: 0, metadata: {} }],
      true,
    ],
    [
      'cash on delivery, not yet collected → not charged',
      'unpaid',
      [{ provider: 'cod', status: 'cod_pending', refundedAmount: 0, metadata: {} }],
      false,
    ],
  ])('%s', async (_name, paymentStatus, payments, charged) => {
    h.orderFindUnique.mockResolvedValue({
      ...ORDER,
      status: 'cancelled',
      paymentStatus,
      payments,
      couponCode: null,
      customerId: null,
    });

    await handleOrderRefunded('o1', 's1', true, true, stepStub);

    expect(h.sendOrderCancelledNotCharged).toHaveBeenCalledTimes(1);
    expect(h.sendOrderCancelledNotCharged.mock.calls[0][1]).toMatchObject({ charged });
    expect(h.sendOrderRefunded).not.toHaveBeenCalled();
  });

  it('once money moved (a refunded amount on the payment), the refund notice goes out', async () => {
    h.orderFindUnique.mockResolvedValue({
      ...ORDER,
      status: 'cancelled',
      payments: [{ refundedAmount: 5000, provider: 'paymob', metadata: {} }],
      couponCode: null,
      customerId: null,
    });

    await handleOrderRefunded('o1', 's1', true, true, stepStub);

    expect(h.sendOrderRefunded).toHaveBeenCalledTimes(1);
    expect(h.sendOrderCancelledNotCharged).not.toHaveBeenCalled();
    expect(createdMarkers()).toContain('refund_notified');
  });

  it('the cancellation notice is sent once per order', async () => {
    h.orderFindUnique.mockResolvedValue({
      ...ORDER,
      status: 'cancelled',
      couponCode: null,
      customerId: null,
    });
    h.orderEventFindFirst.mockImplementation(async (args: { where: { toStatus?: string } }) =>
      args.where.toStatus === 'cancel_notified' ? { id: 'already' } : null
    );

    await handleOrderRefunded('o1', 's1', true, true, stepStub);

    expect(h.sendOrderCancelledNotCharged).not.toHaveBeenCalled();
    expect(h.sendOrderRefunded).not.toHaveBeenCalled();
  });

  it('a failed cancellation email hands the claim back and fails the run for a replay', async () => {
    h.orderFindUnique.mockResolvedValue({
      ...ORDER,
      status: 'cancelled',
      couponCode: null,
      customerId: null,
    });
    h.sendOrderCancelledNotCharged.mockRejectedValueOnce(new Error('render failed'));

    await expect(handleOrderRefunded('o1', 's1', true, true, stepStub)).rejects.toThrow(
      /cancellation email/
    );
    expect(h.orderEventDeleteMany).toHaveBeenCalledWith({
      where: { storeId: 's1', orderId: 'o1', toStatus: 'cancel_notified' },
    });
  });
});
