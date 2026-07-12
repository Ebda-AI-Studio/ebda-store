/**
 * Order Service Unit Tests
 * Tests order creation, status transitions, and business logic
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { OrderService } from '@api/services/order.service';
import { prisma } from '@force/database';
import { EmailService } from '@api/services/email.service';
import { socketService } from '@api/services/socket.service';

// Mock dependencies
vi.mock('@force/database', () => ({
  prisma: {
    order: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    cart: {
      findFirst: vi.fn(),
      create: vi.fn(),
    },
    cartItem: {
      deleteMany: vi.fn(),
    },
    product: {
      findUnique: vi.fn(),
      // findMany backs OrderService.createAdminOrder's price-hydration lookup.
      findMany: vi.fn().mockResolvedValue([]),
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
      create: vi.fn().mockResolvedValue({}),
    },
    coupon: {
      findFirst: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    backorderLine: {
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    $transaction: vi.fn(),
    $queryRaw: vi.fn(),
  },
  Prisma: {},
  OrderStatus: {},
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
    sendAdminNewOrder: vi.fn().mockResolvedValue(undefined),
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
vi.mock('@api/services/feature.service', () => ({
  featureService: {
    isFeatureEnabled: vi.fn().mockResolvedValue(true),
    getStoreFeatures: vi.fn(),
    invalidateCache: vi.fn(),
  },
}));

import { CartService } from '@api/services/cart.service';
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
      city: 'Kuwait City',
      state: 'Capital',
      postalCode: '12345',
      country: 'Kuwait',
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
        city: 'Kuwait City',
        state: 'Capital',
        postalCode: '12345',
        country: 'Kuwait',
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
              deleteMany: vi.fn().mockResolvedValue({}),
            },
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
            $queryRaw: vi.fn().mockResolvedValue([{ inventory: 50 }]),
          } as any);
        }
        return fn;
      });
    });

    it('should create order from cart', async () => {
      const result = await OrderService.create(
        mockStoreId,
        mockCustomerId,
        mockSessionId,
        createOrderData
      );

      expect(result.orderNumber).toBeDefined();
      expect(CartService.getOrCreate).toHaveBeenCalledWith(
        mockStoreId,
        mockSessionId,
        mockCustomerId
      );
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
            cartItem: { deleteMany: vi.fn() },
            inventoryHistory: { create: vi.fn() },
            orderEvent: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn() },
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
      };

      const couponOrderData = { ...createOrderData, couponCode: 'SAVE10' };

      beforeEach(() => {
        vi.mocked(prisma.coupon.findFirst).mockResolvedValue(mockCoupon as any);
      });

      it('registered customer already at usageLimitPerUser → rejects, never creates the order', async () => {
        txOrderCount.mockResolvedValue(1); // already used once, limit is 1

        await expect(
          OrderService.create(mockStoreId, mockCustomerId, mockSessionId, couponOrderData)
        ).rejects.toThrow('Coupon usage limit reached');

        // Counts by customerId, scoped to this coupon + non-cancelled/refunded.
        expect(txOrderCount).toHaveBeenCalledWith(
          expect.objectContaining({
            where: expect.objectContaining({
              storeId: mockStoreId,
              couponCode: 'SAVE10',
              customerId: mockCustomerId,
              status: { notIn: ['cancelled', 'refunded'] },
            }),
          })
        );
        // The global reserve step must never run once the per-user gate rejects.
        expect(txCouponUpdateMany).not.toHaveBeenCalled();
      });

      it('registered customer under usageLimitPerUser → order proceeds', async () => {
        txOrderCount.mockResolvedValue(0);

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
        txOrderCount.mockResolvedValue(1);
        const guestData = {
          ...couponOrderData,
          shippingAddress: { ...couponOrderData.shippingAddress, email: 'guest@test.com' },
        };

        await expect(
          OrderService.create(mockStoreId, undefined, mockSessionId, guestData)
        ).rejects.toThrow('Coupon usage limit reached');

        expect(txOrderCount).toHaveBeenCalledWith(
          expect.objectContaining({
            where: expect.objectContaining({
              storeId: mockStoreId,
              couponCode: 'SAVE10',
              OR: [{ shippingAddress: { path: ['email'], equals: 'guest@test.com' } }],
            }),
          })
        );
      });

      it('guest checkout with NEITHER email nor phone → never blocked (identity ambiguous, fail open)', async () => {
        // Even if txOrderCount were to return a high count, the code must
        // never call it when there's no identifier to key on.
        txOrderCount.mockResolvedValue(99);

        const result = await OrderService.create(
          mockStoreId,
          undefined,
          mockSessionId,
          couponOrderData // shippingAddress has no email/phone
        );

        expect(result.orderNumber).toBeDefined();
        expect(txOrderCount).not.toHaveBeenCalled();
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
        city: 'Kuwait City',
        state: 'Capital',
        postalCode: '12345',
        country: 'Kuwait',
      } as Record<string, unknown>,
      items: [{ productId: 'prod-123', quantity: 1 }],
      paymentMethod: 'cod' as const,
    };

    // Exposed so individual tests can override the per-user coupon count
    // (`tx.order.count`) without rebuilding the whole $transaction mock.
    const txOrderCount = vi.fn().mockResolvedValue(0);

    beforeEach(() => {
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
            // Not used by createAdminOrder itself, but this mock
            // implementation persists on `prisma.$transaction` after this
            // describe block's tests run (vi.clearAllMocks() clears call
            // history, not a previously assigned mockImplementation) and
            // can bleed into a LATER describe block (e.g. `updateStatus`)
            // whose own applyRefundEffects call needs these. Kept as safe
            // no-op defaults so that bleed can't throw.
            product: { update: vi.fn().mockResolvedValue({}) },
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
            $queryRaw: vi.fn().mockResolvedValue([{ inventory: 50, track_inventory: true }]),
          } as any);
        }
        return fn;
      });
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
      };

      const couponAdminOrderData = { ...baseAdminOrderData, couponCode: 'SAVE10' };

      beforeEach(() => {
        vi.mocked(prisma.coupon.findFirst).mockResolvedValue(mockCoupon as any);
      });

      it('registered customer already at usageLimitPerUser → rejects, never creates the admin order', async () => {
        txOrderCount.mockResolvedValue(1); // already used once, limit is 1

        await expect(
          OrderService.createAdminOrder(mockStoreId, mockAdminUserId, {
            ...couponAdminOrderData,
            customerId: mockCustomerId,
          })
        ).rejects.toThrow('Coupon usage limit reached');

        expect(txOrderCount).toHaveBeenCalledWith(
          expect.objectContaining({
            where: expect.objectContaining({
              storeId: mockStoreId,
              couponCode: 'SAVE10',
              customerId: mockCustomerId,
              status: { notIn: ['cancelled', 'refunded'] },
            }),
          })
        );
      });

      it('registered customer under usageLimitPerUser → admin order proceeds', async () => {
        txOrderCount.mockResolvedValue(0);

        const result = await OrderService.createAdminOrder(mockStoreId, mockAdminUserId, {
          ...couponAdminOrderData,
          customerId: mockCustomerId,
        });

        expect(result.orderNumber).toBeDefined();
      });

      it('guest admin order identified by shipping email already at the per-user limit → rejects', async () => {
        txOrderCount.mockResolvedValue(1);

        await expect(
          OrderService.createAdminOrder(mockStoreId, mockAdminUserId, {
            ...couponAdminOrderData,
            shippingAddress: {
              ...couponAdminOrderData.shippingAddress,
              email: 'guest@test.com',
            },
          })
        ).rejects.toThrow('Coupon usage limit reached');

        expect(txOrderCount).toHaveBeenCalledWith(
          expect.objectContaining({
            where: expect.objectContaining({
              storeId: mockStoreId,
              couponCode: 'SAVE10',
              OR: [{ shippingAddress: { path: ['email'], equals: 'guest@test.com' } }],
            }),
          })
        );
      });

      it('guest admin order with NEITHER email nor phone → never blocked (identity ambiguous, fail open)', async () => {
        // Even if txOrderCount were to return a high count, the code must
        // never call it when there's no identifier to key on.
        txOrderCount.mockResolvedValue(99);

        const result = await OrderService.createAdminOrder(
          mockStoreId,
          mockAdminUserId,
          couponAdminOrderData // no customerId, shippingAddress has no email/phone
        );

        expect(result.orderNumber).toBeDefined();
        expect(txOrderCount).not.toHaveBeenCalled();
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

      it('should reject refunded -> any', async () => {
        vi.mocked(prisma.order.findFirst).mockResolvedValue({
          ...mockOrder,
          status: 'refunded',
        } as any);

        await expect(
          OrderService.updateStatus(mockStoreId, 'order-123', 'pending')
        ).rejects.toThrow('Cannot transition from refunded to pending');
      });

      it('should reject shipped -> cancelled', async () => {
        vi.mocked(prisma.order.findFirst).mockResolvedValue({
          ...mockOrder,
          status: 'shipped',
        } as any);

        await expect(
          OrderService.updateStatus(mockStoreId, 'order-123', 'cancelled')
        ).rejects.toThrow('Cannot transition from shipped to cancelled');
      });
    });

    describe('inventory restoration', () => {
      it('should trigger inventory restore transaction on cancellation', async () => {
        vi.mocked(prisma.order.findFirst).mockResolvedValue({
          ...mockOrder,
          status: 'pending',
          // Refund effects (inventory restore) only fire when the order was
          // actually paid — cancelling an UNPAID order must NOT refund.
          paymentStatus: 'paid',
        } as any);

        await OrderService.updateStatus(mockStoreId, 'order-123', 'cancelled');

        // Cancel/refund now wraps inventory restore in a separate $transaction
        // The first call is from updateStatus itself (if applicable), second from inventory restore
        expect(prisma.$transaction).toHaveBeenCalled();
      });

      it('should trigger inventory restore transaction on refund', async () => {
        vi.mocked(prisma.order.findFirst).mockResolvedValue({
          ...mockOrder,
          status: 'delivered',
          paymentStatus: 'paid',
        } as any);

        await OrderService.updateStatus(mockStoreId, 'order-123', 'refunded');

        expect(prisma.$transaction).toHaveBeenCalled();
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

  describe('applyRefundEffects — F2 idempotency rework', () => {
    // Fresh stateful markers per test — a single shared `tx` object whose
    // inventoryHistory/orderEvent mocks persist state across multiple
    // applyRefundEffects invocations within ONE test, so cross-call
    // idempotency can actually be exercised (mirrors the real durable
    // markers living in the DB across calls).
    function makeStatefulTx() {
      let stockMarker: { id: string } | null = null;
      let effectsMarker: { id: string } | null = null;
      return {
        $queryRaw: vi
          .fn()
          .mockResolvedValue([{ id: 'prod-123', inventory: 50, track_inventory: true }]),
        product: { update: vi.fn().mockResolvedValue({}) },
        productVariant: { update: vi.fn().mockResolvedValue({}) },
        inventoryHistory: {
          findFirst: vi.fn(async () => stockMarker),
          create: vi.fn(async () => {
            stockMarker = { id: 'ih-1' };
            return stockMarker;
          }),
        },
        orderEvent: {
          findFirst: vi.fn(async () => effectsMarker),
          create: vi.fn(async () => {
            effectsMarker = { id: 'oe-1' };
            return effectsMarker;
          }),
        },
      };
    }

    beforeEach(() => {
      vi.mocked(prisma.order.update).mockResolvedValue(mockOrder as any);
    });

    it('(a) delivered→refunded via updateStatus: inventory restored once, coupon decremented once, notification fired once', async () => {
      const tx = makeStatefulTx();
      vi.mocked(prisma.$transaction).mockImplementation((fn: any) => fn(tx));

      // A GENUINE new refund of a paid, coupon-bearing order. `refunded` is
      // terminal (validTransitions), so the previously-considered
      // refunded→cancelled second hop can't happen through updateStatus —
      // this asserts the single-pass wiring: exactly one inventory restore,
      // one coupon decrement, one `order/refunded` notification.
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

      expect(tx.inventoryHistory.create).toHaveBeenCalledTimes(1);
      expect(prisma.coupon.updateMany).toHaveBeenCalledTimes(1);
      // applyRefundEffects fires order/refunded exactly once; updateStatus now
      // ALSO fires order/status-changed (Lens E, E2-4) → two sends total.
      expect(inngest.send).toHaveBeenCalledTimes(2);
      const refundedCalls = vi
        .mocked(inngest.send)
        .mock.calls.filter(c => (c[0] as { name?: string })?.name === 'order/refunded');
      expect(refundedCalls).toHaveLength(1);
      expect(refundedCalls[0][0]).toEqual(
        expect.objectContaining({
          name: 'order/refunded',
          data: expect.objectContaining({ orderId: 'order-123' }),
        })
      );
    });

    it('(b) two separate returns on the same order: each fires the notification, but coupon decrements only once', async () => {
      const tx = makeStatefulTx();
      vi.mocked(prisma.$transaction).mockImplementation((fn: any) => fn(tx));
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

      // Inventory restore is order-level coarse (pre-existing, unchanged) —
      // once is correct/acceptable even for two returns.
      expect(tx.inventoryHistory.create).toHaveBeenCalledTimes(1);
      // Coupon must decrement only once for the order, not once per return.
      expect(prisma.coupon.updateMany).toHaveBeenCalledTimes(1);
      // BOTH returns are genuinely separate refund events — each notifies.
      expect(inngest.send).toHaveBeenCalledTimes(2);
    });

    it('(c) restoreInventory:false calls (backorder-line cancels) decrement the coupon at most once per order, never once per line', async () => {
      const tx = makeStatefulTx();
      vi.mocked(prisma.$transaction).mockImplementation((fn: any) => fn(tx));
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

      // Never restores inventory (restoreInventory:false on every call).
      expect(tx.inventoryHistory.create).not.toHaveBeenCalled();
      // Coupon decremented exactly once despite 3 calls — the OLD guard
      // (return_stock-marker-only) never wrote ANY marker on a
      // restoreInventory:false call, so it would have decremented the
      // coupon on EVERY line. The new `refund_effects_applied` marker
      // fixes this.
      expect(prisma.coupon.updateMany).toHaveBeenCalledTimes(1);
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
