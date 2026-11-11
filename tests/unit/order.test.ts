/**
 * Order Service Unit Tests
 * Tests order creation, status transitions, and business logic
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { OrderService } from '@api/services/order.service';
import { prisma } from '@ebda/database';
import { EmailService } from '@api/services/email.service';
import { socketService } from '@api/services/socket.service';

// Mock dependencies
// Money batch B: fiscal documents + the frozen COD fee are covered end-to-end
// by tests/integration/fiscal-documents.test.ts; this unit suite stubs them.
// Gold-rate pricing is proven in gold-*.test.ts and tests/integration/gold-checkout.test.ts; this suite
// is about something else, so the gate is stubbed to "no gold lines".
const priorUses = vi.hoisted(() => vi.fn().mockResolvedValue(0));
vi.mock('@api/lib/coupon-per-customer-limit', () => ({ countPriorCouponUses: priorUses }));
vi.mock('@api/services/gold-rate/gate', () => ({
  assertGoldLinesPriceable: async () => ({ snapshots: new Map(), rateIds: new Map() }),
  assertSameRates: async () => undefined,
  goldQuotesForLines: async () => new Map(),
  goldQuoteKey: (p: string, v: string | null) => `${p}|${v ?? ''}`,
}));
vi.mock('@api/services/price-resolver.service', async () =>
  (await import('../helpers/retail-price-resolver')).retailPriceResolverModule()
);
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  scopeTransaction: (tx: any, _g: unknown, fn: any) => fn(tx),
  prisma: {
    order: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    cart: {
      findFirst: vi.fn(),
      create: vi.fn(),
    },
    cartItem: {
      // the live cart rows are the fixture the test gave getOrCreate
      findMany: vi.fn(
        async () => ((await CartService.getOrCreate('', '', undefined)) as any).items ?? []
      ),
      count: vi.fn().mockResolvedValue(1),
      deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    product: {
      findUnique: vi.fn(),
      // findMany backs BOTH createAdminOrder's price-hydration lookup AND
      // create()'s productInternals fetch (trackInventory + costPrice).
      //
      // It used to resolve to [] for every test, which is the
      // product-hard-deleted-mid-checkout state — an order can never be
      // created in it, because OrderItem.product is a required relation. The
      // suite passed anyway because the trackInventory read defaulted a map
      // miss to `true`. Returning the cart's product means these tests now
      // exercise the state production is actually in; individual tests still
      // override it where they need something else.
      findMany: vi.fn().mockResolvedValue([
        {
          id: 'prod-123',
          name: 'Test Product',
          nameAr: null,
          trackInventory: true,
          costPrice: 500,
          _count: { variants: 0 },
          categories: [],
        },
      ]),
      update: vi.fn(),
    },
    productVariant: {
      update: vi.fn(),
    },
    store: {
      findUnique: vi.fn().mockResolvedValue({ name: 'Test Store' }),
    },
    taxRate: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    // VAT gate (ruling TAX-2): no profile = not verified = no VAT.
    storeTaxProfile: {
      findUnique: vi.fn().mockResolvedValue(null),
    },
    inventoryHistory: {
      // findFirst is the return_stock idempotency marker (return null =
      // "not yet restored" so the restore proceeds).
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({}),
    },
    // orderEvent backs both the status-audit-trail write in updateStatus
    // AND the `refund_effects_applied` once-per-order marker inside
    // applyRefundEffects (F2 rework). Default findFirst → null ("not yet
    // applied") so the coupon decrement proceeds; tests that exercise the
    // idempotency guard override this per-call.
    orderEvent: {
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]), // getById reads the warehouse allocations (WAREHOUSE-ROUTE-1)
      create: vi.fn().mockResolvedValue({}),
    },
    coupon: {
      findFirst: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    // customer + promotion back the checkout targeting resolver
    // (resolveCustomerContext / resolveBestPromotion) invoked before the order
    // transaction. Defaults: no matching customer (guest, first order) and no
    // active automatic promotions, so the coupon-only paths are unchanged.
    customer: {
      findFirst: vi.fn().mockResolvedValue(null),
    },
    // resolveCustomerContext looks up the account contact (phone/email) by
    // customerId when the checkout is for a registered customer (Fix B).
    // Default: no matching user row → falls back to the passed shipping
    // phone/email, same targeting behavior as before Fix B.
    user: {
      findUnique: vi.fn().mockResolvedValue(null),
      // findFirst backs createAdminOrder's customerId ownership check — an
      // attached customer must belong to THIS store (2026-09-02 audit).
      // Default: resolves, so tests that don't exercise it are unaffected.
      findFirst: vi.fn().mockResolvedValue({ id: 'customer-1', status: 'active', deletedAt: null }),
    },
    promotion: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    backorderLine: {
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    $transaction: vi.fn(),
    // Default: no existing open holds, so assertStockHoldCapNotExceeded's
    // transaction raw-SQL count (lib/stock-hold-cap.ts) never fires
    // unless a test explicitly overrides this to simulate an abuser already
    // at/over the cap.
    $executeRaw: vi.fn().mockResolvedValue(1),
    $queryRaw: vi.fn().mockResolvedValue([{ phone_or_email_count: 0n, ip_count: 0n }]),
  },
  Prisma: {},
  OrderStatus: {},
  // Tenant-scoped reads (resolveActiveTaxRate etc.) run through withStore; pass the mocked client through.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  withStore: async (_storeId: string, fn: any) => fn((await import('@ebda/database')).prisma),
  hasTenantContext: () => true,
  // withMoneyTx (F6) wraps prisma.$transaction. Delegate to the mocked
  // $transaction so existing `expect(prisma.$transaction).toHaveBeenCalled()`
  // assertions still hold; fall back to invoking the callback directly if a
  // test passes a client without a mocked $transaction.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  withMoneyTx: (client: any, fn: any) =>
    client?.$transaction ? client.$transaction(fn) : fn(client),
}));

vi.mock('@api/services/email.service', () => ({
  EmailService: {
    sendOrderConfirmation: vi.fn().mockResolvedValue(undefined),
    sendOrderShipped: vi.fn().mockResolvedValue(undefined),
    sendPaymentSuccess: vi.fn().mockResolvedValue(undefined),
    sendAdminRefund: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('@api/services/socket.service', () => ({
  socketService: {
    newOrderNotification: vi.fn(),
    orderStatusNotification: vi.fn(),
  },
}));

vi.mock('@api/services/cart.service', () => ({
  CartService: {
    getOrCreate: vi.fn(),
  },
}));

// Spy on the `order/refunded` fanout (the "Refund issued" merchant push +
// customer refund email trigger) so the F2 idempotency tests can assert
// exactly how many times it fired without a real Inngest client.
vi.mock('@api/lib/inngest/client', () => ({
  inngest: {
    send: vi.fn().mockResolvedValue({ ids: [] }),
    // order.service.ts transitively imports order-status-changed.ts, which
    // registers a fan-out via inngest.createFunction at module load. The mock
    // must expose it or the whole suite fails to import.
    createFunction: vi.fn(() => ({})),
  },
}));

// The order service checks the inventory.backorder feature flag before
// creating BackorderLine rows. Default to enabled so existing tests that
// don't care about this flag still pass unmodified.
// Order-cap gate has its own suite (order-plan-grace.test.ts); stubbed here.
vi.mock('@api/services/plan-limit.service', () => ({
  assertOrderAllowed: vi.fn().mockResolvedValue(undefined),
  noteOrderCreated: vi.fn().mockResolvedValue({ over: false }),
}));

vi.mock('@api/services/feature.service', () => ({
  featureService: {
    isFeatureEnabled: vi.fn().mockResolvedValue(true),
    getStoreFeatures: vi.fn(),
    invalidateCache: vi.fn(),
  },
}));

import { CartService } from '@api/services/cart.service';
import { assertOrderAllowed } from '@api/services/plan-limit.service';
import { inngest } from '@api/lib/inngest/client';

describe('OrderService', () => {
  const mockStoreId = 'store-123';
  const mockCustomerId = 'customer-456';
  const mockSessionId = 'session-789';

  const mockProduct = {
    id: 'prod-123',
    name: 'Test Product',
    price: 5000,
    inventory: 50,
    trackInventory: true,
    sku: 'TST-001',
    images: [{ url: 'https://example.com/image.jpg' }],
  };

  const mockCartWithItems = {
    id: 'cart-123',
    storeId: mockStoreId,
    sessionId: mockSessionId,
    customerId: mockCustomerId,
    items: [
      {
        id: 'item-1',
        productId: 'prod-123',
        quantity: 2,
        product: mockProduct,
      },
    ],
    subtotal: 10000,
  };

  const mockCustomer = {
    id: mockCustomerId,
    email: 'customer@test.com',
    firstName: 'Test',
    lastName: 'Customer',
  };

  const mockOrder = {
    id: 'order-123',
    storeId: mockStoreId,
    customerId: mockCustomerId,
    orderNumber: 'ORD-123456',
    status: 'pending',
    subtotal: 10000,
    tax: 1000,
    shipping: 0,
    total: 11000,
    shippingAddress: {
      firstName: 'Test',
      lastName: 'Customer',
      address1: '123 Test St',
      city: 'Cairo',
      state: 'Capital',
      postalCode: '12345',
      country: 'Egypt',
    },
    items: [
      {
        id: 'orderitem-1',
        productId: 'prod-123',
        productName: 'Test Product',
        sku: 'TST-001',
        quantity: 2,
        price: 5000,
        total: 10000,
      },
    ],
    customer: mockCustomer,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('list — keyset pagination stability', () => {
    it('orders by createdAt AND id, so a cursor page boundary cannot skip or repeat', async () => {
      vi.mocked(prisma.order.findMany).mockResolvedValue([mockOrder] as never);
      vi.mocked(prisma.order.count).mockResolvedValue(1);

      await OrderService.list(mockStoreId, { cursor: 'order-1', limit: 20 });

      const args = vi.mocked(prisma.order.findMany).mock.calls.at(-1)?.[0] as {
        orderBy: unknown;
      };
      // createdAt alone is NOT unique — bulk-imported or same-second orders
      // share a timestamp, and keyset pagination is only stable when the ORDER
      // BY uniquely identifies the cursor row. Without the id tiebreaker a page
      // boundary landing inside such a group drops orders from the admin list
      // or shows them twice.
      expect(args.orderBy).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);
    });
  });

  describe('list', () => {
    it('should return paginated orders', async () => {
      const mockOrders = [mockOrder, { ...mockOrder, id: 'order-456' }];
      vi.mocked(prisma.order.findMany).mockResolvedValue(mockOrders as any);
      vi.mocked(prisma.order.count).mockResolvedValue(2);

      const result = await OrderService.list(mockStoreId);

      expect(result.orders).toHaveLength(2);
      expect(result.meta.total).toBe(2);
      expect(result.meta.page).toBe(1);
      expect(result.meta.limit).toBe(20);
    });

    it('should filter by status', async () => {
      vi.mocked(prisma.order.findMany).mockResolvedValue([mockOrder] as any);
      vi.mocked(prisma.order.count).mockResolvedValue(1);

      await OrderService.list(mockStoreId, { status: 'pending' });

      expect(prisma.order.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ status: 'pending' }),
        })
      );
    });

    it('should filter by customerId', async () => {
      vi.mocked(prisma.order.findMany).mockResolvedValue([mockOrder] as any);
      vi.mocked(prisma.order.count).mockResolvedValue(1);

      await OrderService.list(mockStoreId, { customerId: mockCustomerId });

      expect(prisma.order.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ customerId: mockCustomerId }),
        })
      );
    });

    it('should handle pagination correctly', async () => {
      vi.mocked(prisma.order.findMany).mockResolvedValue([]);
      vi.mocked(prisma.order.count).mockResolvedValue(100);

      const result = await OrderService.list(mockStoreId, { page: 3, limit: 10 });

      expect(prisma.order.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          skip: 20, // (3-1) * 10
          take: 10,
        })
      );
      expect(result.meta.totalPages).toBe(10);
    });
  });

  describe('getById', () => {
    it('should return order with items and customer', async () => {
      vi.mocked(prisma.order.findFirst).mockResolvedValue(mockOrder as any);

      const result = await OrderService.getById(mockStoreId, 'order-123');

      expect(result).toEqual(mockOrder);
      // `deletedAt: null` is part of the defensive soft-delete filter
      // added in tier-2 hardening — Order has a soft-delete column the
      // schema declares but no caller currently sets, and we don't want
      // a future archive feature to leak archived rows through getById.
      expect(prisma.order.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'order-123', storeId: mockStoreId, deletedAt: null },
        })
      );
    });

    it('should throw error if order not found', async () => {
      vi.mocked(prisma.order.findFirst).mockResolvedValue(null);

      await expect(OrderService.getById(mockStoreId, 'nonexistent')).rejects.toThrow(
        'Order not found'
      );
    });
  });

  describe('getByOrderNumber', () => {
    it('should return order by order number', async () => {
      vi.mocked(prisma.order.findFirst).mockResolvedValue(mockOrder as any);

      const result = await OrderService.getByOrderNumber(mockStoreId, 'ORD-123456');

      expect(result.orderNumber).toBe('ORD-123456');
    });

    it('should throw error if order not found', async () => {
      vi.mocked(prisma.order.findFirst).mockResolvedValue(null);

      await expect(OrderService.getByOrderNumber(mockStoreId, 'INVALID')).rejects.toThrow(
        'Order not found'
      );
    });
  });

  describe('create', () => {
    const createOrderData = {
      shippingAddress: {
        firstName: 'Test',
        lastName: 'Customer',
        address1: '123 Test St',
        city: 'Cairo',
        state: 'Capital',
        postalCode: '12345',
        country: 'Egypt',
      },
      paymentMethod: 'cod',
    };

    // Exposed so individual tests can override the per-user coupon count
    // (`tx.order.count`) and the global reserve (`tx.coupon.updateMany`)
    // without rebuilding the whole $transaction mock.
    const txOrderCount = vi.fn().mockResolvedValue(0);
    const txCouponUpdateMany = vi.fn().mockResolvedValue({ count: 1 });

    beforeEach(() => {
      vi.mocked(CartService.getOrCreate).mockResolvedValue(mockCartWithItems as any);
      vi.mocked(prisma.taxRate.findMany).mockResolvedValue([]);
      txOrderCount.mockReset().mockResolvedValue(0);
      txCouponUpdateMany.mockReset().mockResolvedValue({ count: 1 });
      // The transaction's cap read delegates to this isolated mock; inventory
      // reads use their own response. Reset admission counts for every test.
      vi.mocked(prisma.$queryRaw)
        .mockReset()
        .mockResolvedValue([{ phone_or_email_count: 0n, ip_count: 0n }]);
      vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) => {
        if (typeof fn === 'function') {
          return fn({
            order: {
              create: vi.fn().mockResolvedValue(mockOrder),
              count: txOrderCount,
            },
            coupon: {
              updateMany: txCouponUpdateMany,
            },
            product: {
              update: vi.fn().mockResolvedValue({}),
            },
            productVariant: {
              update: vi.fn().mockResolvedValue({}),
            },
            cartItem: {
              // the live cart rows are the fixture the test gave getOrCreate
              findMany: vi.fn(
                async () => ((await CartService.getOrCreate('', '', undefined)) as any).items ?? []
              ),
              count: vi.fn().mockResolvedValue(1),
              deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
            },
            cartBundle: {
              findMany: vi.fn(
                async () =>
                  ((await CartService.getOrCreate('', '', undefined)) as any).bundles ?? []
              ),
              count: vi.fn().mockResolvedValue(0),
              deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
            },
            $queryRaw: vi.fn().mockResolvedValue([]),
            inventoryHistory: {
              // return_stock idempotency marker: null = not yet restored.
              findFirst: vi.fn().mockResolvedValue(null),
              create: vi.fn().mockResolvedValue({}),
              // Order creation now writes the sale-line ledger via a single
              // batched createMany instead of one create() per cart line.
              createMany: vi.fn().mockResolvedValue({ count: 0 }),
            },
            // refund_effects_applied marker (F2 rework) — this tx mock is
            // reused by other describe blocks whose own beforeEach doesn't
            // reset `$transaction` (vi.clearAllMocks() clears call history,
            // not a previously assigned mockImplementation), so it must
            // carry orderEvent too or a later applyRefundEffects call
            // (e.g. from an updateStatus cancel/refund test) throws on
            // `tx.orderEvent` being undefined.
            orderEvent: {
              findFirst: vi.fn().mockResolvedValue(null),
              create: vi.fn().mockResolvedValue({}),
            },
            $executeRaw: vi.fn().mockResolvedValue(1),
            $queryRaw: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) =>
              strings.join('').includes('phone_or_email_count')
                ? prisma.$queryRaw(strings, ...values)
                : Promise.resolve([{ inventory: 50 }])
            ),
          } as any);
        }
        return fn;
      });
    });

    // Stock-hold cap bypass regression: /orders and /public/orders accept
    // paymentMethod as a bare `z.string()` (not an enum, unlike
    // /payments/create's `provider`), so a client sending mixed case must
    // not silently skip the cap check (lib/stock-hold-cap.ts) by failing the
    // exact 'cod'/'instapay' Set lookup. `create()` must canonicalize
    // (trim+lowercase) BEFORE that check runs.
    describe('paymentMethod casing — stock-hold cap must not be bypassable by case', () => {
      it.each(['COD', 'Cod', ' cod '])(
        'treats paymentMethod %j the same as "cod" for the cap',
        async casedMethod => {
          // already at the default cap (2 open phone/email-matched holds)
          vi.mocked(prisma.$queryRaw).mockResolvedValueOnce([
            { phone_or_email_count: 2n, ip_count: 0n },
          ]);
          await expect(
            OrderService.create(mockStoreId, undefined, mockSessionId, {
              ...createOrderData,
              shippingAddress: { ...createOrderData.shippingAddress, phone: '+201000000000' },
              paymentMethod: casedMethod,
            })
          ).rejects.toMatchObject({ statusCode: 429, code: 'TOO_MANY_OPEN_HOLDS' });
        }
      );

      it.each(['INSTAPAY', 'InstaPay'])(
        'treats paymentMethod %j the same as "instapay" for the cap',
        async casedMethod => {
          vi.mocked(prisma.$queryRaw).mockResolvedValueOnce([
            { phone_or_email_count: 2n, ip_count: 0n },
          ]);
          await expect(
            OrderService.create(mockStoreId, undefined, mockSessionId, {
              ...createOrderData,
              shippingAddress: { ...createOrderData.shippingAddress, phone: '+201000000000' },
              paymentMethod: casedMethod,
            })
          ).rejects.toMatchObject({ statusCode: 429, code: 'TOO_MANY_OPEN_HOLDS' });
        }
      );
    });

    it('should create order from cart', async () => {
      const result = await OrderService.create(
        mockStoreId,
        mockCustomerId,
        mockSessionId,
        createOrderData
      );

      expect(result.orderNumber).toBeDefined();
      // priced below with the real buyer, so the cart service's own pricing pass is skipped (money review M-7)
      expect(CartService.getOrCreate).toHaveBeenCalledWith(
        mockStoreId,
        mockSessionId,
        mockCustomerId,
        expect.objectContaining({ kind: 'anonymous' }),
        { skipPricing: true }
      );
    });

    /**
     * The cart's product rows are re-fetched for trackInventory and costPrice.
     * A hard delete between cart load and order creation leaves that map
     * short, and the trackInventory read used to default the miss to `true` —
     * so the order attempted an inventory decrement and an inventory-history
     * row for a product that no longer exists. It could never have committed:
     * OrderItem.product is a required relation, so the transaction dies on the
     * foreign key regardless — but only after the decrement was attempted, and
     * with an opaque Prisma error instead of something actionable.
     */
    it('rejects a cart whose product was deleted mid-checkout, before any stock moves', async () => {
      // The product is gone: the internals lookup returns nothing for it.
      vi.mocked(prisma.product.findMany).mockResolvedValueOnce([] as never);

      await expect(
        OrderService.create(mockStoreId, mockCustomerId, mockSessionId, createOrderData)
      ).rejects.toThrow(/no longer available/i);
    });

    it('order-cap gate: both order-creation entry points stop BEFORE any cart/stock/transaction work', async () => {
      const capped = Object.assign(new Error('cap'), { statusCode: 402 });
      vi.mocked(assertOrderAllowed).mockRejectedValueOnce(capped);
      await expect(
        OrderService.create(mockStoreId, mockCustomerId, mockSessionId, createOrderData)
      ).rejects.toBe(capped);
      expect(CartService.getOrCreate).not.toHaveBeenCalled();

      vi.mocked(assertOrderAllowed).mockRejectedValueOnce(capped);
      await expect(
        OrderService.createAdminOrder(mockStoreId, 'admin-1', { items: [] } as never)
      ).rejects.toBe(capped);
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(assertOrderAllowed).toHaveBeenCalledTimes(2);
      expect(assertOrderAllowed).toHaveBeenCalledWith(mockStoreId);
    });

    it('should throw error if cart is empty', async () => {
      vi.mocked(CartService.getOrCreate).mockResolvedValue({
        ...mockCartWithItems,
        items: [],
      } as any);

      await expect(
        OrderService.create(mockStoreId, mockCustomerId, mockSessionId, createOrderData)
      ).rejects.toThrow('Cart is empty');
    });

    it('should throw error if insufficient inventory', async () => {
      vi.mocked(CartService.getOrCreate).mockResolvedValue({
        ...mockCartWithItems,
        items: [
          {
            ...mockCartWithItems.items[0],
            quantity: 100,
            product: { ...mockProduct, inventory: 10 },
          },
        ],
      } as any);

      // Inventory is guarded by an atomic conditional decrement
      // (`UPDATE … WHERE inventory >= qty RETURNING`). A losing/insufficient
      // write affects 0 rows → $queryRaw resolves to [] → ok=false. With
      // backorder disallowed (findUnique → allowBackorder:false) it throws.
      vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) => {
        if (typeof fn === 'function') {
          return fn({
            order: { create: vi.fn() },
            product: {
              update: vi.fn(),
              findUnique: vi.fn().mockResolvedValue({ allowBackorder: false }),
            },
            productVariant: {
              update: vi.fn(),
              findUnique: vi.fn().mockResolvedValue({ allowBackorder: false }),
            },
            cartItem: {
              // the live cart rows are the fixture the test gave getOrCreate
              findMany: vi.fn(
                async () => ((await CartService.getOrCreate('', '', undefined)) as any).items ?? []
              ),
              count: vi.fn().mockResolvedValue(1),
              deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
            },
            cartBundle: {
              findMany: vi.fn(
                async () =>
                  ((await CartService.getOrCreate('', '', undefined)) as any).bundles ?? []
              ),
              count: vi.fn().mockResolvedValue(0),
              deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
            },
            $queryRaw: vi.fn().mockResolvedValue([]),
            inventoryHistory: { create: vi.fn() },
            orderEvent: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn() },
            $executeRaw: vi.fn().mockResolvedValue(1),
            $queryRaw: vi.fn().mockResolvedValue([]),
          } as any);
        }
        return fn;
      });

      await expect(
        OrderService.create(mockStoreId, mockCustomerId, mockSessionId, createOrderData)
      ).rejects.toThrow('Not enough inventory');
    });

    it('should enqueue order/created Inngest event (email fanout is async)', async () => {
      // Confirmation email is now sent inside the order/created Inngest
      // handler (not inline) so OrderService.create only enqueues the event.
      // We verify the socket notification still fires synchronously, which
      // is the in-process side-effect that the admin page depends on.
      await OrderService.create(mockStoreId, mockCustomerId, mockSessionId, createOrderData);

      // sendOrderConfirmation is NOT called inline — it fires inside the Inngest
      // order/created handler. Inline email mocks should NOT be asserted here.
      expect(EmailService.sendOrderConfirmation).not.toHaveBeenCalled();
    });

    it('should send real-time notification', async () => {
      await OrderService.create(mockStoreId, mockCustomerId, mockSessionId, createOrderData);

      expect(socketService.newOrderNotification).toHaveBeenCalledWith(
        mockStoreId,
        expect.objectContaining({
          orderNumber: expect.any(String),
        })
      );
    });

    it('should continue even if email fails', async () => {
      vi.mocked(EmailService.sendOrderConfirmation).mockRejectedValue(new Error('Email failed'));

      // Should not throw
      await expect(
        OrderService.create(mockStoreId, mockCustomerId, mockSessionId, createOrderData)
      ).resolves.toBeDefined();
    });

    // Money-integrity audit: `usageLimitPerUser` was collected + stored but
    // never enforced — only the store-wide `usageLimit` was. These cover the
    // new per-customer gate in OrderService.create.
    // #1380 — the free_shipping coupon eligibility guard. Targeting used to be
    // skipped for free_shipping, zeroing the delivery fee for anyone who typed
    // a code restricted to a group / first order / min quantity / scope.
    describe('free_shipping coupon targeting', () => {
      const freeShipCoupon = (targeting: Record<string, unknown>) => ({
        id: 'coupon-fs',
        storeId: mockStoreId,
        code: 'FREESHIP',
        type: 'free_shipping',
        value: 0,
        minOrderAmount: null,
        maxDiscount: null,
        usageLimit: null,
        usageCount: 0,
        usageLimitPerUser: null,
        isActive: true,
        startsAt: new Date(Date.now() - 86400000),
        expiresAt: new Date(Date.now() + 86400000),
        customerGroupId: null,
        firstOrderOnly: false,
        minQuantity: null,
        scopeProductIds: [],
        scopeCategoryIds: [],
        ...targeting,
      });

      let capturedOrderData: Record<string, unknown> | undefined;
      beforeEach(async () => {
        capturedOrderData = undefined;
        const { ShippingService } = await import('@api/services/shipping.service');
        vi.spyOn(ShippingService, 'calculateShipping').mockResolvedValue({
          shippingCost: 1500,
          freeShipping: false,
          matched: true,
          storeHasAreaRates: false,
        } as never);
        vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) =>
          fn({
            order: {
              create: vi.fn().mockImplementation((args: any) => {
                capturedOrderData = args.data;
                return Promise.resolve({ ...mockOrder, ...args.data });
              }),
              count: txOrderCount,
            },
            coupon: { updateMany: txCouponUpdateMany },
            product: { update: vi.fn().mockResolvedValue({}) },
            productVariant: { update: vi.fn().mockResolvedValue({}) },
            cartItem: {
              // the live cart rows are the fixture the test gave getOrCreate
              findMany: vi.fn(
                async () => ((await CartService.getOrCreate('', '', undefined)) as any).items ?? []
              ),
              count: vi.fn().mockResolvedValue(1),
              deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
            },
            cartBundle: {
              findMany: vi.fn(
                async () =>
                  ((await CartService.getOrCreate('', '', undefined)) as any).bundles ?? []
              ),
              count: vi.fn().mockResolvedValue(0),
              deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
            },
            $queryRaw: vi.fn().mockResolvedValue([]),
            inventoryHistory: {
              findFirst: vi.fn().mockResolvedValue(null),
              create: vi.fn().mockResolvedValue({}),
              createMany: vi.fn().mockResolvedValue({ count: 0 }),
            },
            orderEvent: {
              findFirst: vi.fn().mockResolvedValue(null),
              create: vi.fn().mockResolvedValue({}),
            },
            $executeRaw: vi.fn().mockResolvedValue(1),
            $queryRaw: vi.fn().mockResolvedValue([{ inventory: 50 }]),
          })
        );
      });

      it('rejects an ineligible free_shipping coupon with COUPON_NOT_ELIGIBLE', async () => {
        vi.mocked(prisma.coupon.findFirst).mockResolvedValue(
          freeShipCoupon({ minQuantity: 999 }) as any
        );

        await expect(
          OrderService.create(mockStoreId, mockCustomerId, mockSessionId, {
            ...createOrderData,
            couponCode: 'FREESHIP',
          })
        ).rejects.toMatchObject({ code: 'COUPON_NOT_ELIGIBLE' });
        expect(capturedOrderData).toBeUndefined();
      });

      it('zeroes shipping for an eligible free_shipping coupon', async () => {
        vi.mocked(prisma.coupon.findFirst).mockResolvedValue(freeShipCoupon({}) as any);

        await OrderService.create(mockStoreId, mockCustomerId, mockSessionId, {
          ...createOrderData,
          couponCode: 'FREESHIP',
        });

        expect(capturedOrderData?.shipping).toBe(0);
      });

      it('control: without the coupon the delivery fee is charged', async () => {
        await OrderService.create(mockStoreId, mockCustomerId, mockSessionId, createOrderData);
        expect(capturedOrderData?.shipping).toBe(1500);
      });
    });

    describe('coupon usageLimitPerUser enforcement', () => {
      const mockCoupon = {
        id: 'coupon-1',
        storeId: mockStoreId,
        code: 'SAVE10',
        type: 'percentage',
        value: 10,
        minOrderAmount: null,
        maxDiscount: null,
        usageLimit: null,
        usageCount: 0,
        usageLimitPerUser: 1,
        isActive: true,
        startsAt: new Date(Date.now() - 86400000),
        expiresAt: new Date(Date.now() + 86400000),
        // Targeting facets (shared with promotions). All empty = "everyone,
        // whole cart" so CouponService.evaluateForCart applies the discount to
        // the full subtotal, matching the legacy calculateDiscount behaviour.
        customerGroupId: null,
        firstOrderOnly: false,
        minQuantity: null,
        scopeProductIds: [],
        scopeCategoryIds: [],
      };

      const couponOrderData = { ...createOrderData, couponCode: 'SAVE10' };

      beforeEach(() => {
        vi.mocked(prisma.coupon.findFirst).mockResolvedValue(mockCoupon as any);
      });

      it('registered customer already at usageLimitPerUser → rejects, never creates the order', async () => {
        priorUses.mockResolvedValue(1); // already used once, limit is 1

        await expect(
          OrderService.create(mockStoreId, mockCustomerId, mockSessionId, couponOrderData)
        ).rejects.toThrow('Coupon usage limit reached');

        // Counts by customerId, scoped to this coupon + non-cancelled/refunded.
        expect(priorUses).toHaveBeenCalledWith(
          expect.anything(),
          mockStoreId,
          'SAVE10',
          expect.objectContaining({ customerId: mockCustomerId })
        );
        // The global reserve step must never run once the per-user gate rejects.
        expect(txCouponUpdateMany).not.toHaveBeenCalled();
      });

      it('registered customer under usageLimitPerUser → order proceeds', async () => {
        priorUses.mockResolvedValue(0);

        const result = await OrderService.create(
          mockStoreId,
          mockCustomerId,
          mockSessionId,
          couponOrderData
        );

        expect(result.orderNumber).toBeDefined();
        expect(txCouponUpdateMany).toHaveBeenCalled();
      });

      it('guest checkout identified by shipping email already at the per-user limit → rejects', async () => {
        priorUses.mockResolvedValue(1);
        const guestData = {
          ...couponOrderData,
          shippingAddress: { ...couponOrderData.shippingAddress, email: 'guest@test.com' },
        };

        await expect(
          OrderService.create(mockStoreId, undefined, mockSessionId, guestData)
        ).rejects.toThrow('Coupon usage limit reached');

        expect(priorUses).toHaveBeenCalledWith(
          expect.anything(),
          mockStoreId,
          'SAVE10',
          expect.objectContaining({ customerId: undefined })
        );
      });

      it('guest checkout with NEITHER email nor phone → REFUSED the per-customer coupon (no stable identity), nothing created', async () => {
        const { AppError } = await import('@api/middleware/error-handler');
        priorUses.mockRejectedValueOnce(new AppError(400, 'COUPON_NEEDS_CONTACT', 'needs contact'));

        await expect(
          OrderService.create(mockStoreId, undefined, mockSessionId, couponOrderData) // no email/phone
        ).rejects.toMatchObject({ code: 'COUPON_NEEDS_CONTACT' });

        expect(txCouponUpdateMany).not.toHaveBeenCalled(); // the redemption is never claimed
      });

      it('coupon with no usageLimitPerUser set → skips the per-user check entirely', async () => {
        vi.mocked(prisma.coupon.findFirst).mockResolvedValue({
          ...mockCoupon,
          usageLimitPerUser: null,
        } as any);

        const result = await OrderService.create(
          mockStoreId,
          mockCustomerId,
          mockSessionId,
          couponOrderData
        );

        expect(result.orderNumber).toBeDefined();
        expect(txOrderCount).not.toHaveBeenCalled();
      });
    });

    // Regression: exact-tie double-count bug. When a discount coupon and an
    // automatic promotion produce the SAME non-zero discount, the promotion
    // is recorded (appliedPromotionId is set on ties — see
    // resolveBestPromotion/promotionDiscount >= couponDiscount), so the
    // coupon must NOT also be recorded/consumed. Before the fix, `discount`
    // stayed correct (via primaryDiscount) but the persisted breakdown
    // double-counted: couponDiscount === promotionDiscount === D.
    describe('exact-tie coupon vs promotion (no double-count)', () => {
      const mockCoupon = {
        id: 'coupon-tie',
        storeId: mockStoreId,
        code: 'TIE10',
        type: 'fixed',
        value: 1000,
        minOrderAmount: null,
        maxDiscount: null,
        usageLimit: null,
        usageCount: 0,
        usageLimitPerUser: null,
        isActive: true,
        startsAt: new Date(Date.now() - 86400000),
        expiresAt: new Date(Date.now() + 86400000),
        customerGroupId: null,
        firstOrderOnly: false,
        minQuantity: null,
        scopeProductIds: [],
        scopeCategoryIds: [],
      };

      const mockPromotion = {
        id: 'promo-tie',
        storeId: mockStoreId,
        type: 'fixed',
        value: 1000,
        maxDiscount: null,
        priority: 0,
        isActive: true,
        startsAt: null,
        expiresAt: null,
        createdAt: new Date(),
        customerGroupId: null,
        firstOrderOnly: false,
        minOrderAmount: null,
        minQuantity: null,
        scopeProductIds: [],
        scopeCategoryIds: [],
      };

      it('coupon and promotion tie on discount → promotion is recorded once, coupon is not double-counted', async () => {
        vi.mocked(prisma.coupon.findFirst).mockResolvedValue(mockCoupon as any);
        vi.mocked(prisma.promotion.findMany).mockResolvedValue([mockPromotion] as any);

        // Cart subtotal is 10000 piastres (2 * 5000). Both levers discount
        // exactly 1000 piastres — a genuine tie, not just an equal-looking input.
        let capturedOrderData: Record<string, unknown> | undefined;
        vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) => {
          if (typeof fn === 'function') {
            return fn({
              order: {
                create: vi.fn().mockImplementation((args: any) => {
                  capturedOrderData = args.data;
                  return Promise.resolve({ ...mockOrder, ...args.data });
                }),
                count: txOrderCount,
              },
              coupon: { updateMany: txCouponUpdateMany },
              product: { update: vi.fn().mockResolvedValue({}) },
              productVariant: { update: vi.fn().mockResolvedValue({}) },
              cartItem: {
                // the live cart rows are the fixture the test gave getOrCreate
                findMany: vi.fn(
                  async () =>
                    ((await CartService.getOrCreate('', '', undefined)) as any).items ?? []
                ),
                count: vi.fn().mockResolvedValue(1),
                deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
              },
              cartBundle: {
                findMany: vi.fn(
                  async () =>
                    ((await CartService.getOrCreate('', '', undefined)) as any).bundles ?? []
                ),
                count: vi.fn().mockResolvedValue(0),
                deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
              },
              $queryRaw: vi.fn().mockResolvedValue([]),
              inventoryHistory: {
                findFirst: vi.fn().mockResolvedValue(null),
                create: vi.fn().mockResolvedValue({}),
                createMany: vi.fn().mockResolvedValue({ count: 0 }),
              },
              orderEvent: {
                findFirst: vi.fn().mockResolvedValue(null),
                create: vi.fn().mockResolvedValue({}),
              },
              $executeRaw: vi.fn().mockResolvedValue(1),
              $queryRaw: vi.fn().mockResolvedValue([{ inventory: 50 }]),
            } as any);
          }
          return fn;
        });

        const result = await OrderService.create(mockStoreId, mockCustomerId, mockSessionId, {
          ...createOrderData,
          couponCode: 'TIE10',
        });

        expect(result).toBeDefined();
        expect(capturedOrderData).toBeDefined();
        // The authoritative discount counts the tie once, not twice.
        expect(capturedOrderData!.discount).toBe(1000);
        // The promotion is the recorded lever (ties resolve to the promotion).
        expect(capturedOrderData!.promotionDiscount).toBe(1000);
        expect(capturedOrderData!.appliedPromotionId).toBe('promo-tie');
        // The coupon must NOT also be recorded — this is the bug this test
        // guards against: without the fix both fields would read 1000.
        expect(capturedOrderData!.couponDiscount).toBe(0);
        expect(capturedOrderData!.couponCode).toBeNull();
        // And it must not have been consumed (no usage-count reservation).
        expect(txCouponUpdateMany).not.toHaveBeenCalled();
      });
    });

    // Regression (Task 5 review, Fix C): the highest-risk money path — an
    // automatic promotion's discount STRICTLY exceeds an entered coupon's
    // discount. The promotion must win outright: it is the sole discount
    // recorded, the coupon must not be treated as applied, and critically
    // its usage must NOT be reserved/incremented (a coupon that lost the
    // best-of comparison was never actually redeemed).
    describe('promotion strictly beats coupon (best-of, no coupon usage reserved)', () => {
      const mockCoupon = {
        id: 'coupon-loses',
        storeId: mockStoreId,
        code: 'SMALL10',
        type: 'fixed',
        value: 1000,
        minOrderAmount: null,
        maxDiscount: null,
        usageLimit: null,
        usageCount: 0,
        usageLimitPerUser: null,
        isActive: true,
        startsAt: new Date(Date.now() - 86400000),
        expiresAt: new Date(Date.now() + 86400000),
        customerGroupId: null,
        firstOrderOnly: false,
        minQuantity: null,
        scopeProductIds: [],
        scopeCategoryIds: [],
      };

      const mockPromotion = {
        id: 'promo-wins',
        storeId: mockStoreId,
        type: 'fixed',
        value: 3000,
        maxDiscount: null,
        priority: 0,
        isActive: true,
        startsAt: null,
        expiresAt: null,
        createdAt: new Date(),
        customerGroupId: null,
        firstOrderOnly: false,
        minOrderAmount: null,
        minQuantity: null,
        scopeProductIds: [],
        scopeCategoryIds: [],
      };

      it('promotion (3000 piastres) strictly beats coupon (1000 piastres) → promotion wins, coupon unused', async () => {
        vi.mocked(prisma.coupon.findFirst).mockResolvedValue(mockCoupon as any);
        vi.mocked(prisma.promotion.findMany).mockResolvedValue([mockPromotion] as any);

        // Cart subtotal is 10000 piastres (2 * 5000). Coupon discounts 1000 piastres,
        // promotion discounts 3000 piastres — a genuine, non-tied strict win.
        let capturedOrderData: Record<string, unknown> | undefined;
        vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) => {
          if (typeof fn === 'function') {
            return fn({
              order: {
                create: vi.fn().mockImplementation((args: any) => {
                  capturedOrderData = args.data;
                  return Promise.resolve({ ...mockOrder, ...args.data });
                }),
                count: txOrderCount,
              },
              coupon: { updateMany: txCouponUpdateMany },
              product: { update: vi.fn().mockResolvedValue({}) },
              productVariant: { update: vi.fn().mockResolvedValue({}) },
              cartItem: {
                // the live cart rows are the fixture the test gave getOrCreate
                findMany: vi.fn(
                  async () =>
                    ((await CartService.getOrCreate('', '', undefined)) as any).items ?? []
                ),
                count: vi.fn().mockResolvedValue(1),
                deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
              },
              cartBundle: {
                findMany: vi.fn(
                  async () =>
                    ((await CartService.getOrCreate('', '', undefined)) as any).bundles ?? []
                ),
                count: vi.fn().mockResolvedValue(0),
                deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
              },
              $queryRaw: vi.fn().mockResolvedValue([]),
              inventoryHistory: {
                findFirst: vi.fn().mockResolvedValue(null),
                create: vi.fn().mockResolvedValue({}),
                createMany: vi.fn().mockResolvedValue({ count: 0 }),
              },
              orderEvent: {
                findFirst: vi.fn().mockResolvedValue(null),
                create: vi.fn().mockResolvedValue({}),
              },
              $executeRaw: vi.fn().mockResolvedValue(1),
              $queryRaw: vi.fn().mockResolvedValue([{ inventory: 50 }]),
            } as any);
          }
          return fn;
        });

        const result = await OrderService.create(mockStoreId, mockCustomerId, mockSessionId, {
          ...createOrderData,
          couponCode: 'SMALL10',
        });

        expect(result).toBeDefined();
        expect(capturedOrderData).toBeDefined();
        // The promotion's larger discount is the one actually applied.
        expect(capturedOrderData!.discount).toBe(3000);
        expect(capturedOrderData!.promotionDiscount).toBe(3000);
        expect(capturedOrderData!.appliedPromotionId).toBe('promo-wins');
        // The coupon lost the best-of comparison — it must not be recorded
        // as applied at all.
        expect(capturedOrderData!.couponDiscount).toBe(0);
        expect(capturedOrderData!.couponCode).toBeNull();
        // And, critically, its usage must not be reserved/incremented — a
        // losing coupon was never actually redeemed.
        expect(txCouponUpdateMany).not.toHaveBeenCalled();
      });
    });
  });

  describe('createAdminOrder', () => {
    const mockAdminUserId = 'admin-user-1';
    const mockProductForAdmin = {
      id: 'prod-123',
      name: 'Test Product',
      price: 5000,
      sku: 'TST-001',
      status: 'active',
      variants: [],
    };
    const baseAdminOrderData = {
      shippingAddress: {
        firstName: 'Test',
        lastName: 'Customer',
        address1: '123 Test St',
        city: 'Cairo',
        state: 'Capital',
        postalCode: '12345',
        country: 'Egypt',
      } as Record<string, unknown>,
      items: [{ productId: 'prod-123', quantity: 1 }],
      paymentMethod: 'cod' as const,
    };

    // Exposed so individual tests can override the per-user coupon count
    // (`tx.order.count`) without rebuilding the whole $transaction mock.
    const txOrderCount = vi.fn().mockResolvedValue(0);
    const txCouponReserve = vi.fn().mockResolvedValue({ count: 1 });

    beforeEach(() => {
      txCouponReserve.mockReset().mockResolvedValue({ count: 1 });
      vi.mocked(prisma.product.findMany).mockResolvedValue([mockProductForAdmin] as any);
      vi.mocked(prisma.taxRate.findMany).mockResolvedValue([]);
      txOrderCount.mockReset().mockResolvedValue(0);
      vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) => {
        if (typeof fn === 'function') {
          return fn({
            order: {
              create: vi.fn().mockResolvedValue(mockOrder),
              count: txOrderCount,
            },
            // The atomic redemption reservation (#1370): admin orders now
            // count toward usageCount like checkout.
            coupon: { updateMany: txCouponReserve },
            // Not used by createAdminOrder itself, but this mock
            // implementation persists on `prisma.$transaction` after this
            // describe block's tests run (vi.clearAllMocks() clears call
            // history, not a previously assigned mockImplementation) and
            // can bleed into a LATER describe block (e.g. `updateStatus`)
            // whose own applyRefundEffects call needs these. Kept as safe
            // no-op defaults so that bleed can't throw.
            // findMany: the admin order's tracked-product lookup for the stock reservation (none tracked here)
            product: {
              update: vi.fn().mockResolvedValue({}),
              findMany: vi.fn().mockResolvedValue([]),
            },
            productVariant: { update: vi.fn().mockResolvedValue({}) },
            inventoryHistory: {
              findFirst: vi.fn().mockResolvedValue(null),
              create: vi.fn().mockResolvedValue({}),
            },
            // refund_effects_applied marker (money F2 rework) — applyRefundEffects
            // reads tx.orderEvent.findFirst; this bleeding mock must provide it.
            orderEvent: {
              findFirst: vi.fn().mockResolvedValue(null),
              create: vi.fn().mockResolvedValue({}),
            },
            $executeRaw: vi.fn().mockResolvedValue(1),
            $queryRaw: vi.fn().mockResolvedValue([{ inventory: 50, track_inventory: true }]),
          } as any);
        }
        return fn;
      });
    });

    it('C-01: a product with variants and no variantId is refused (400 VARIANT_REQUIRED, ar + en), nothing written', async () => {
      vi.mocked(prisma.product.findMany).mockResolvedValue([
        { ...mockProductForAdmin, variants: [{ id: 'var-m', price: 5200, title: 'M' }] },
      ] as any);
      const err = await OrderService.createAdminOrder(
        mockStoreId,
        mockAdminUserId,
        baseAdminOrderData
      ).catch(e => e);
      expect(err).toMatchObject({ statusCode: 400, code: 'VARIANT_REQUIRED' });
      expect(err.details).toMatchObject({ productId: 'prod-123' });
      expect(err.details.messageEn).toContain('Test Product');
      expect(err.details.messageAr).toMatch(/[\u0600-\u06FF]/);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('W1b carry: a DISABLED variant is refused (409 VARIANT_INACTIVE), nothing written', async () => {
      vi.mocked(prisma.product.findMany).mockResolvedValue([
        {
          ...mockProductForAdmin,
          variants: [{ id: 'var-m', price: 5200, title: 'M', isActive: false }],
        },
      ] as any);
      const err = await OrderService.createAdminOrder(mockStoreId, mockAdminUserId, {
        ...baseAdminOrderData,
        items: [{ productId: 'prod-123', variantId: 'var-m', quantity: 1 }],
      } as any).catch(e => e);
      expect(err).toMatchObject({ statusCode: 409, code: 'VARIANT_INACTIVE' });
      expect(err.details).toMatchObject({ productId: 'prod-123', variantId: 'var-m' });
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('an ACTIVE variant of the product is accepted', async () => {
      vi.mocked(prisma.product.findMany).mockResolvedValue([
        {
          ...mockProductForAdmin,
          variants: [{ id: 'var-m', price: 5200, title: 'M', isActive: true }],
        },
      ] as any);
      const result = await OrderService.createAdminOrder(mockStoreId, mockAdminUserId, {
        ...baseAdminOrderData,
        items: [{ productId: 'prod-123', variantId: 'var-m', quantity: 1 }],
      } as any);
      expect(result.orderNumber).toBeDefined();
    });

    it('creates an admin order with no coupon (per-user check never runs)', async () => {
      const result = await OrderService.createAdminOrder(
        mockStoreId,
        mockAdminUserId,
        baseAdminOrderData
      );

      expect(result.orderNumber).toBeDefined();
      expect(txOrderCount).not.toHaveBeenCalled();
    });

    // #193 (owner decision): the manual-order path levies VAT after the coupon
    // discount too. 5000 goods − 10% coupon (500) = 4500 × 5% = 225, not 250.
    it('levies VAT on the subtotal net of the coupon discount', async () => {
      // resolveActiveTaxRate gates the charge on taxEnabled + the `tax`
      // feature too, since ruling M3-9 — an active rate row alone is no
      // longer enough (the global mock's `isFeatureEnabled` already
      // resolves true; only taxEnabled needs setting here).
      vi.mocked(prisma.store.findUnique).mockResolvedValue({
        name: 'Test Store',
        taxEnabled: true,
      } as any);
      vi.mocked(prisma.taxRate.findMany).mockResolvedValue([{ rate: 5 }] as any);
      // VAT is charged only under a VERIFIED tax profile (ruling TAX-2).
      vi.mocked(prisma.storeTaxProfile.findUnique).mockResolvedValue({
        status: 'verified',
        taxRegistrationNumber: '123456789',
        legalName: 'Test Store LLC',
      } as any);
      vi.mocked(prisma.coupon.findFirst).mockResolvedValue({
        id: 'coupon-vat',
        storeId: mockStoreId,
        code: 'SAVE10',
        type: 'percentage',
        value: 10,
        minOrderAmount: null,
        maxDiscount: null,
        usageLimit: null,
        usageCount: 0,
        usageLimitPerUser: null,
        isActive: true,
        startsAt: null,
        expiresAt: null,
        customerGroupId: null,
        firstOrderOnly: false,
        minQuantity: null,
        scopeProductIds: [],
        scopeCategoryIds: [],
      } as any);
      const create = vi.fn().mockResolvedValue(mockOrder);
      vi.mocked(prisma.$transaction).mockImplementationOnce(async (fn: any) =>
        fn({
          order: { create, count: txOrderCount },
          product: { findMany: vi.fn().mockResolvedValue([]) },
          orderEvent: { create: vi.fn() },
          coupon: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
          $executeRaw: vi.fn().mockResolvedValue(1),
          $queryRaw: vi.fn().mockResolvedValue([]),
        } as any)
      );

      await OrderService.createAdminOrder(mockStoreId, mockAdminUserId, {
        ...baseAdminOrderData,
        couponCode: 'SAVE10',
      });

      const data = create.mock.calls[0][0].data;
      expect(data.subtotal).toBe(5000);
      expect(data.tax).toBe(225);
      expect(data.total).toBe(5000 - 500 + 225 + data.shipping);
      // The tax-invoice identity is frozen onto the order (ruling TAX-2).
      expect(data.sellerTaxRegistrationNumber).toBe('123456789');
      expect(data.sellerTaxLegalName).toBe('Test Store LLC');
      expect(data.taxRateBps).toBe(500);
    });

    // Money-integrity audit gap (2026-07-02, #498 follow-up): createAdminOrder
    // resolved coupons via CouponService.getByCode (store-wide usageLimit
    // only) and never ran the per-customer usageLimitPerUser gate that
    // OrderService.create already got. These mirror the `create` coverage
    // above for the admin/manual-order path.
    describe('coupon usageLimitPerUser enforcement', () => {
      const mockCoupon = {
        id: 'coupon-1',
        storeId: mockStoreId,
        code: 'SAVE10',
        type: 'percentage',
        value: 10,
        minOrderAmount: null,
        maxDiscount: null,
        usageLimit: null,
        usageCount: 0,
        usageLimitPerUser: 1,
        isActive: true,
        startsAt: new Date(Date.now() - 86400000),
        expiresAt: new Date(Date.now() + 86400000),
        // Targeting (#1370): admin orders now run the checkout rules.
        customerGroupId: null,
        firstOrderOnly: false,
        minQuantity: null,
        scopeProductIds: [],
        scopeCategoryIds: [],
      };

      const couponAdminOrderData = { ...baseAdminOrderData, couponCode: 'SAVE10' };

      beforeEach(() => {
        vi.mocked(prisma.coupon.findFirst).mockResolvedValue(mockCoupon as any);
      });

      it('registered customer already at usageLimitPerUser → rejects, never creates the admin order', async () => {
        priorUses.mockResolvedValue(1); // already used once, limit is 1

        await expect(
          OrderService.createAdminOrder(mockStoreId, mockAdminUserId, {
            ...couponAdminOrderData,
            customerId: mockCustomerId,
          })
        ).rejects.toThrow('Coupon usage limit reached');

        expect(priorUses).toHaveBeenCalledWith(
          expect.anything(),
          mockStoreId,
          'SAVE10',
          expect.objectContaining({ customerId: mockCustomerId })
        );
      });

      it('registered customer under usageLimitPerUser → admin order proceeds', async () => {
        priorUses.mockResolvedValue(0);

        const result = await OrderService.createAdminOrder(mockStoreId, mockAdminUserId, {
          ...couponAdminOrderData,
          customerId: mockCustomerId,
        });

        expect(result.orderNumber).toBeDefined();
        // The use is reserved in the order transaction (#1370).
        expect(txCouponReserve).toHaveBeenCalledWith({
          where: { id: 'coupon-1', storeId: mockStoreId, isActive: true },
          data: { usageCount: { increment: 1 } },
        });
      });

      it('guest admin order identified by shipping email already at the per-user limit → rejects', async () => {
        priorUses.mockResolvedValue(1);

        await expect(
          OrderService.createAdminOrder(mockStoreId, mockAdminUserId, {
            ...couponAdminOrderData,
            shippingAddress: {
              ...couponAdminOrderData.shippingAddress,
              email: 'guest@test.com',
            },
          })
        ).rejects.toThrow('Coupon usage limit reached');

        expect(priorUses).toHaveBeenCalledWith(
          expect.anything(),
          mockStoreId,
          'SAVE10',
          expect.objectContaining({ customerId: undefined })
        );
      });

      it('guest admin order with NEITHER email nor phone → refused (an admin override reports it as a violation instead)', async () => {
        const { AppError } = await import('@api/middleware/error-handler');
        priorUses.mockRejectedValueOnce(new AppError(400, 'COUPON_NEEDS_CONTACT', 'needs contact'));
        await expect(
          OrderService.createAdminOrder(mockStoreId, mockAdminUserId, couponAdminOrderData)
        ).rejects.toMatchObject({ code: 'COUPON_NEEDS_CONTACT' });
      });

      it('coupon with no usageLimitPerUser set → skips the per-user check entirely', async () => {
        vi.mocked(prisma.coupon.findFirst).mockResolvedValue({
          ...mockCoupon,
          usageLimitPerUser: null,
        } as any);

        const result = await OrderService.createAdminOrder(mockStoreId, mockAdminUserId, {
          ...couponAdminOrderData,
          customerId: mockCustomerId,
        });

        expect(result.orderNumber).toBeDefined();
        expect(txOrderCount).not.toHaveBeenCalled();
      });
    });
  });

  describe('updateStatus', () => {
    beforeEach(() => {
      vi.mocked(prisma.order.update).mockResolvedValue(mockOrder as any);
    });

    describe('valid transitions', () => {
      it('should allow pending -> confirmed', async () => {
        vi.mocked(prisma.order.findFirst).mockResolvedValue({
          ...mockOrder,
          status: 'pending',
        } as any);

        await expect(
          OrderService.updateStatus(mockStoreId, 'order-123', 'confirmed')
        ).resolves.toBeDefined();
      });

      it('should allow pending -> cancelled', async () => {
        vi.mocked(prisma.order.findFirst).mockResolvedValue({
          ...mockOrder,
          status: 'pending',
        } as any);

        await expect(
          OrderService.updateStatus(mockStoreId, 'order-123', 'cancelled')
        ).resolves.toBeDefined();
      });

      // #558 / #619 — every transition arms the status-changed fanout: a fresh
      // request stamp and a re-nulled claim, in the SAME update as the status.
      it('arms the status-changed fanout claim with the status write', async () => {
        vi.mocked(prisma.order.findFirst).mockResolvedValue({
          ...mockOrder,
          status: 'confirmed',
        } as any);

        await OrderService.updateStatus(mockStoreId, 'order-123', 'processing');

        expect(prisma.order.update).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({
              status: 'processing',
              statusFanoutRequestedAt: expect.any(Date),
              statusFanoutClaimedAt: null,
              // issue 2070: WHICH transition, for the stuck sweep.
              statusFanoutRequestedStatus: 'processing',
              statusFanoutCompletedAt: null,
            }),
          })
        );
      });

      it('should allow confirmed -> processing', async () => {
        vi.mocked(prisma.order.findFirst).mockResolvedValue({
          ...mockOrder,
          status: 'confirmed',
        } as any);

        await expect(
          OrderService.updateStatus(mockStoreId, 'order-123', 'processing')
        ).resolves.toBeDefined();
      });

      it('should allow processing -> shipped', async () => {
        vi.mocked(prisma.order.findFirst).mockResolvedValue({
          ...mockOrder,
          status: 'processing',
        } as any);

        await expect(
          OrderService.updateStatus(mockStoreId, 'order-123', 'shipped')
        ).resolves.toBeDefined();
      });

      it('should allow shipped -> delivered', async () => {
        vi.mocked(prisma.order.findFirst).mockResolvedValue({
          ...mockOrder,
          status: 'shipped',
        } as any);

        await expect(
          OrderService.updateStatus(mockStoreId, 'order-123', 'delivered')
        ).resolves.toBeDefined();
      });

      it('should allow delivered -> refunded', async () => {
        vi.mocked(prisma.order.findFirst).mockResolvedValue({
          ...mockOrder,
          status: 'delivered',
        } as any);

        await expect(
          OrderService.updateStatus(mockStoreId, 'order-123', 'refunded')
        ).resolves.toBeDefined();
      });
    });

    describe('invalid transitions', () => {
      // pending → delivered is now allowed by design (commit 0ee3741) so an
      // admin can mark a same-day COD as delivered without stepping through
      // every intermediate state. Test left as a sanity-check that the
      // transition resolves rather than rejects.
      it('should allow pending -> delivered (admin shortcut)', async () => {
        vi.mocked(prisma.order.findFirst).mockResolvedValue({
          ...mockOrder,
          status: 'pending',
        } as any);

        await expect(
          OrderService.updateStatus(mockStoreId, 'order-123', 'delivered')
        ).resolves.toBeDefined();
      });

      it('should reject cancelled -> any', async () => {
        vi.mocked(prisma.order.findFirst).mockResolvedValue({
          ...mockOrder,
          status: 'cancelled',
        } as any);

        await expect(
          OrderService.updateStatus(mockStoreId, 'order-123', 'confirmed')
        ).rejects.toThrow('Cannot transition from cancelled to confirmed');
      });

      it('should allow a PAID cancelled order -> refunded (PR #770)', async () => {
        vi.mocked(prisma.order.findFirst).mockResolvedValue({
          ...mockOrder,
          status: 'cancelled',
          paymentStatus: 'paid',
        } as any);

        await expect(
          OrderService.updateStatus(mockStoreId, 'order-123', 'refunded')
        ).resolves.toBeDefined();
      });

      it('should reject marking an UNPAID cancelled or pending order refunded', async () => {
        for (const status of ['cancelled', 'pending']) {
          vi.mocked(prisma.order.findFirst).mockResolvedValue({
            ...mockOrder,
            status,
            paymentStatus: 'pending',
            payments: [],
          } as any);

          await expect(
            OrderService.updateStatus(mockStoreId, 'order-123', 'refunded')
          ).rejects.toThrow('cannot be marked refunded');
        }
      });

      it('should reject refunded -> any', async () => {
        vi.mocked(prisma.order.findFirst).mockResolvedValue({
          ...mockOrder,
          status: 'refunded',
        } as any);

        await expect(
          OrderService.updateStatus(mockStoreId, 'order-123', 'pending')
        ).rejects.toThrow('Cannot transition from refunded to pending');
      });

      // shipped -> cancelled is now VALID: it is the return-to-origin exit
      // (ruling MONEYB-5). A delivered order still cannot be cancelled.
      it('should reject delivered -> cancelled', async () => {
        vi.mocked(prisma.order.findFirst).mockResolvedValue({
          ...mockOrder,
          status: 'delivered',
        } as any);

        await expect(
          OrderService.updateStatus(mockStoreId, 'order-123', 'cancelled')
        ).rejects.toThrow('Cannot transition from delivered to cancelled');
      });
    });

    describe('inventory restoration', () => {
      // Money-integrity redesign (2026-07-16, Task 1): inventory restore no
      // longer runs inline inside updateStatus/applyRefundEffects — it moves
      // into the `order-refunded` Inngest fanout as an idempotent step
      // (Tasks 2-3). `applyRefundEffects` now just fires `order/refunded`
      // with `restoreInventory` so the fanout knows whether to restore.
      it('should fire order/refunded with restoreInventory:true on cancellation', async () => {
        vi.mocked(prisma.order.findFirst).mockResolvedValue({
          ...mockOrder,
          status: 'pending',
          // Refund effects (inventory restore) only fire when the order was
          // actually paid — cancelling an UNPAID order must NOT refund.
          paymentStatus: 'paid',
        } as any);

        await OrderService.updateStatus(mockStoreId, 'order-123', 'cancelled');

        expect(inngest.send).toHaveBeenCalledWith(
          expect.objectContaining({
            name: 'order/refunded',
            data: expect.objectContaining({ restoreInventory: true, notify: true }),
          })
        );
      });

      it('should fire order/refunded with restoreInventory:true on refund', async () => {
        vi.mocked(prisma.order.findFirst).mockResolvedValue({
          ...mockOrder,
          status: 'delivered',
          paymentStatus: 'paid',
        } as any);

        await OrderService.updateStatus(mockStoreId, 'order-123', 'refunded');

        expect(inngest.send).toHaveBeenCalledWith(
          expect.objectContaining({
            name: 'order/refunded',
            data: expect.objectContaining({ restoreInventory: true, notify: true }),
          })
        );
      });
    });

    describe('email notifications', () => {
      it('should send shipped email', async () => {
        vi.mocked(prisma.order.findFirst).mockResolvedValue({
          ...mockOrder,
          status: 'processing',
        } as any);
        vi.mocked(prisma.order.update).mockResolvedValue({
          ...mockOrder,
          status: 'shipped',
        } as any);

        await OrderService.updateStatus(mockStoreId, 'order-123', 'shipped');

        // Post-purchase side effects (shipped email + dispatch) now fan out on
        // the order/status-changed Inngest event (Lens E, E2-4) — the actual
        // EmailService call is asserted in order-status-changed.test.ts.
        // updateStatus just emits the event.
        expect(inngest.send).toHaveBeenCalledWith(
          expect.objectContaining({
            name: 'order/status-changed',
            data: expect.objectContaining({ status: 'shipped' }),
          })
        );
      });

      it('should send payment success email on confirmation', async () => {
        vi.mocked(prisma.order.findFirst).mockResolvedValue({
          ...mockOrder,
          status: 'pending',
        } as any);
        vi.mocked(prisma.order.update).mockResolvedValue({
          ...mockOrder,
          status: 'confirmed',
        } as any);

        await OrderService.updateStatus(mockStoreId, 'order-123', 'confirmed');

        // Payment-success email now fans out on order/status-changed (E2-4).
        expect(inngest.send).toHaveBeenCalledWith(
          expect.objectContaining({
            name: 'order/status-changed',
            data: expect.objectContaining({ status: 'confirmed' }),
          })
        );
      });

      it('should send admin refund email', async () => {
        vi.mocked(prisma.order.findFirst).mockResolvedValue({
          ...mockOrder,
          status: 'delivered',
          paymentStatus: 'paid',
        } as any);
        vi.mocked(prisma.order.update).mockResolvedValue({
          ...mockOrder,
          status: 'refunded',
        } as any);

        await OrderService.updateStatus(mockStoreId, 'order-123', 'refunded');

        // Admin-refund email now fans out on order/status-changed with
        // hadCapturedPayment=true (E2-4) — the gate + send are asserted in
        // order-status-changed.test.ts.
        expect(inngest.send).toHaveBeenCalledWith(
          expect.objectContaining({
            name: 'order/status-changed',
            data: expect.objectContaining({ status: 'refunded', hadCapturedPayment: true }),
          })
        );
      });
    });

    describe('real-time notifications', () => {
      it('should send status notification to customer', async () => {
        vi.mocked(prisma.order.findFirst).mockResolvedValue({
          ...mockOrder,
          status: 'pending',
        } as any);
        vi.mocked(prisma.order.update).mockResolvedValue({
          ...mockOrder,
          status: 'confirmed',
        } as any);

        await OrderService.updateStatus(mockStoreId, 'order-123', 'confirmed');

        expect(socketService.orderStatusNotification).toHaveBeenCalledWith(
          mockCustomerId,
          expect.objectContaining({
            orderNumber: mockOrder.orderNumber,
            status: 'confirmed',
          })
        );
      });
    });
  });

  // Money-integrity redesign (2026-07-16, Task 1): `applyRefundEffects` is no
  // longer where inventory/coupon/affiliate/loyalty/backorder reversals run,
  // or where their idempotency is decided — it is a thin dispatcher that
  // fires `order/refunded` with `{ restoreInventory, notify }` flags. The
  // reversals (and their idempotent markers) move into the `order-refunded`
  // Inngest fanout as retriable `step.run`s in Tasks 2-3 of the plan
  // (`docs/superpowers/plans/2026-07-16-refund-money-integrity.md`) — their
  // idempotency is covered by `tests/unit/order-refunded-reversals.test.ts`
  // once that lands, not here. This block only covers the event-firing
  // contract; more direct-call coverage lives in
  // `apps/api/src/services/__tests__/order-refund-gating.test.ts`.
  describe('applyRefundEffects — fires order/refunded, no inline reversals', () => {
    beforeEach(() => {
      vi.mocked(prisma.order.update).mockResolvedValue(mockOrder as any);
    });

    it('delivered→refunded via updateStatus: fires order/refunded once with restoreInventory:true, notify:true; no inline reversal', async () => {
      // A GENUINE new refund of a paid, coupon-bearing order. `refunded` is
      // terminal (validTransitions), so the previously-considered
      // refunded→cancelled second hop can't happen through updateStatus.
      vi.mocked(prisma.order.findFirst).mockResolvedValue({
        ...mockOrder,
        status: 'delivered',
        paymentStatus: 'paid',
        couponCode: 'SAVE10',
      } as any);
      vi.mocked(prisma.order.update).mockResolvedValue({
        ...mockOrder,
        status: 'refunded',
      } as any);

      await OrderService.updateStatus(mockStoreId, 'order-123', 'refunded');

      // applyRefundEffects fires order/refunded exactly once; updateStatus now
      // ALSO fires order/status-changed (Lens E, E2-4) → two sends total.
      expect(inngest.send).toHaveBeenCalledTimes(2);
      const refundedCalls = vi
        .mocked(inngest.send)
        .mock.calls.filter(c => (c[0] as { name?: string })?.name === 'order/refunded');
      expect(refundedCalls).toHaveLength(1);
      expect(refundedCalls[0][0]).toEqual({
        name: 'order/refunded',
        // reverseWallet: whole-order cancels/refunds put any customer-wallet
        // spend back (D1); only the backorder single-line cancel opts out.
        data: {
          orderId: 'order-123',
          storeId: mockStoreId,
          restoreInventory: true,
          notify: true,
          reverseWallet: true,
        },
      });

      // No inline reversal — that now happens in the order-refunded fanout.
      expect(prisma.coupon.updateMany).not.toHaveBeenCalled();
      expect(prisma.inventoryHistory.create).not.toHaveBeenCalled();
    });

    it('two separate returns on the same order: applyRefundEffects fires order/refunded each time (dedup now lives in the fanout)', async () => {
      vi.mocked(prisma.order.findFirst).mockResolvedValue({
        ...mockOrder,
        status: 'delivered',
        couponCode: 'SAVE10',
      } as any);

      // Simulates ReturnService.complete() calling applyRefundEffects
      // directly (default options), once per completed return, twice for
      // two SEPARATE Return requests on the same order.
      await OrderService.applyRefundEffects(mockStoreId, 'order-123');
      await OrderService.applyRefundEffects(mockStoreId, 'order-123');

      expect(inngest.send).toHaveBeenCalledTimes(2);
      expect(prisma.coupon.updateMany).not.toHaveBeenCalled();
    });

    it('restoreInventory:false calls (backorder-line cancels) carry the flag through on every call', async () => {
      vi.mocked(prisma.order.findFirst).mockResolvedValue({
        ...mockOrder,
        status: 'delivered',
        couponCode: 'SAVE10',
      } as any);

      // Simulates accounting/backorder.service.ts cancelBackorder calling
      // applyRefundEffects once per BackorderLine, 3 lines on the same
      // order, all with restoreInventory:false (inventory was never
      // reserved for a backordered item).
      await OrderService.applyRefundEffects(mockStoreId, 'order-123', { restoreInventory: false });
      await OrderService.applyRefundEffects(mockStoreId, 'order-123', { restoreInventory: false });
      await OrderService.applyRefundEffects(mockStoreId, 'order-123', { restoreInventory: false });

      expect(inngest.send).toHaveBeenCalledTimes(3);
      for (const call of vi.mocked(inngest.send).mock.calls) {
        expect(call[0]).toEqual(
          expect.objectContaining({
            name: 'order/refunded',
            data: expect.objectContaining({ restoreInventory: false }),
          })
        );
      }
      expect(prisma.inventoryHistory.create).not.toHaveBeenCalled();
      expect(prisma.coupon.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('getCustomerOrders', () => {
    it('should return all orders for a customer', async () => {
      const customerOrders = [mockOrder, { ...mockOrder, id: 'order-456' }];
      vi.mocked(prisma.order.findMany).mockResolvedValue(customerOrders as any);
      vi.mocked(prisma.order.count).mockResolvedValue(2);

      const result = await OrderService.getCustomerOrders(mockStoreId, mockCustomerId);

      expect(result.orders).toHaveLength(2);
      expect(result.meta.total).toBe(2);
      expect(prisma.order.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { storeId: mockStoreId, customerId: mockCustomerId, deletedAt: null },
          orderBy: { createdAt: 'desc' },
        })
      );
    });
  });
});
