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
      update: vi.fn(),
    },
    $transaction: vi.fn(),
  },
  Prisma: {},
  OrderStatus: {},
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

import { CartService } from '@api/services/cart.service';

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
      expect(prisma.order.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'order-123', storeId: mockStoreId },
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

    beforeEach(() => {
      vi.mocked(CartService.getOrCreate).mockResolvedValue(mockCartWithItems as any);
      vi.mocked(prisma.$transaction).mockImplementation(async fn => {
        return fn({
          order: {
            create: vi.fn().mockResolvedValue(mockOrder),
          },
          product: {
            update: vi.fn().mockResolvedValue({}),
          },
          cartItem: {
            deleteMany: vi.fn().mockResolvedValue({}),
          },
        } as any);
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

      await expect(
        OrderService.create(mockStoreId, mockCustomerId, mockSessionId, createOrderData)
      ).rejects.toThrow('Not enough inventory');
    });

    it('should send order confirmation emails', async () => {
      await OrderService.create(mockStoreId, mockCustomerId, mockSessionId, createOrderData);

      expect(EmailService.sendOrderConfirmation).toHaveBeenCalled();
      expect(EmailService.sendAdminNewOrder).toHaveBeenCalled();
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
      it('should reject pending -> delivered', async () => {
        vi.mocked(prisma.order.findFirst).mockResolvedValue({
          ...mockOrder,
          status: 'pending',
        } as any);

        await expect(
          OrderService.updateStatus(mockStoreId, 'order-123', 'delivered')
        ).rejects.toThrow('Cannot transition from pending to delivered');
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
      it('should restore inventory on cancellation', async () => {
        vi.mocked(prisma.order.findFirst).mockResolvedValue({
          ...mockOrder,
          status: 'pending',
        } as any);

        await OrderService.updateStatus(mockStoreId, 'order-123', 'cancelled');

        expect(prisma.product.update).toHaveBeenCalledWith({
          where: { id: 'prod-123' },
          data: { inventory: { increment: 2 } },
        });
      });

      it('should restore inventory on refund', async () => {
        vi.mocked(prisma.order.findFirst).mockResolvedValue({
          ...mockOrder,
          status: 'delivered',
        } as any);

        await OrderService.updateStatus(mockStoreId, 'order-123', 'refunded');

        expect(prisma.product.update).toHaveBeenCalledWith({
          where: { id: 'prod-123' },
          data: { inventory: { increment: 2 } },
        });
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

        expect(EmailService.sendOrderShipped).toHaveBeenCalledWith(
          expect.objectContaining({
            customerEmail: mockCustomer.email,
            orderNumber: mockOrder.orderNumber,
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

        expect(EmailService.sendPaymentSuccess).toHaveBeenCalled();
      });

      it('should send admin refund email', async () => {
        vi.mocked(prisma.order.findFirst).mockResolvedValue({
          ...mockOrder,
          status: 'delivered',
        } as any);
        vi.mocked(prisma.order.update).mockResolvedValue({
          ...mockOrder,
          status: 'refunded',
        } as any);

        await OrderService.updateStatus(mockStoreId, 'order-123', 'refunded');

        expect(EmailService.sendAdminRefund).toHaveBeenCalledWith(
          expect.objectContaining({
            orderNumber: mockOrder.orderNumber,
            amount: mockOrder.total,
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

  describe('getCustomerOrders', () => {
    it('should return all orders for a customer', async () => {
      const customerOrders = [mockOrder, { ...mockOrder, id: 'order-456' }];
      vi.mocked(prisma.order.findMany).mockResolvedValue(customerOrders as any);

      const result = await OrderService.getCustomerOrders(mockStoreId, mockCustomerId);

      expect(result).toHaveLength(2);
      expect(prisma.order.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { storeId: mockStoreId, customerId: mockCustomerId },
          orderBy: { createdAt: 'desc' },
        })
      );
    });
  });
});
