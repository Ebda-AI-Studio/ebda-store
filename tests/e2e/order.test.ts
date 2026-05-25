/**
 * Order Flow E2E Tests
 * Tests critical order flows: cart, checkout, payment webhook
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express, { Router } from 'express';
import { prisma } from '@force/database';
import orderRoutes from '@api/routes/order.routes';
import webhookRoutes from '@api/routes/webhook.routes';
import authRoutes from '@api/routes/auth.routes';
import { CartService } from '@api/services/cart.service';
import { errorHandler } from '@api/middleware/error-handler';

// Order routes expect mergeParams so req.params.storeId is accessible inside the router.
// Mount under /stores/:storeId/orders matching the production route shape.
const app = express();
app.use(express.json());
app.use('/auth', authRoutes);
const storeRouter = Router({ mergeParams: true });
storeRouter.use('/:storeId/orders', orderRoutes);
app.use('/stores', storeRouter);
app.use('/webhooks', webhookRoutes);
app.use(errorHandler);

// Test data
let testStoreId: string | null = null;
let testUserId: string | null = null;
let testProductId: string | null = null;
let authToken: string | null = null;
let createdOrderId: string | null = null;
// Session ID that ties the test cart to the order request
const TEST_SESSION_ID = `test-session-${Date.now()}`;

describe('Order Flow', () => {
  beforeAll(async () => {
    // Create test user
    const hashedPassword = await import('bcryptjs').then(bcrypt => bcrypt.hash('Test123!@#', 12));

    const user = await prisma.user.create({
      data: {
        email: `order-test-${Date.now()}@example.com`,
        passwordHash: hashedPassword,
        firstName: 'Order',
        lastName: 'Tester',
        role: 'super_admin',
        status: 'active',
        emailVerified: true,
      },
    });
    testUserId = user.id;

    // Create test store
    const store = await prisma.store.create({
      data: {
        name: 'Order Test Store',
        slug: `order-test-store-${Date.now()}`,
        ownerId: user.id,
        status: 'active',
      },
    });
    testStoreId = store.id;

    // Create test product
    const product = await prisma.product.create({
      data: {
        storeId: store.id,
        name: 'Order Test Product',
        slug: `order-test-product-${Date.now()}`,
        price: 5000, // 5 KWD in fils
        inventory: 100,
        status: 'active',
      },
    });
    testProductId = product.id;

    // Login
    const loginRes = await request(app).post('/auth/login').send({
      email: user.email,
      password: 'Test123!@#',
    });
    authToken = loginRes.body.data?.accessToken;
  });

  afterAll(async () => {
    // Cleanup in reverse creation order
    if (createdOrderId) {
      await prisma.orderItem.deleteMany({ where: { orderId: createdOrderId } });
      await prisma.order.delete({ where: { id: createdOrderId } }).catch(() => {});
    }
    // Remove any carts created for the test session
    if (testStoreId) {
      await prisma.cartItem.deleteMany({
        where: { cart: { storeId: testStoreId, sessionId: TEST_SESSION_ID } },
      });
      await prisma.cart.deleteMany({
        where: { storeId: testStoreId, sessionId: TEST_SESSION_ID },
      });
    }
    if (testProductId) {
      await prisma.product.delete({ where: { id: testProductId } }).catch(() => {});
    }
    if (testStoreId) {
      await prisma.store.delete({ where: { id: testStoreId } }).catch(() => {});
    }
    if (testUserId) {
      await prisma.user.delete({ where: { id: testUserId } }).catch(() => {});
    }
    await prisma.$disconnect();
  });

  describe('POST /stores/:storeId/orders', () => {
    it('should create an order with valid data', async () => {
      if (!authToken || !testStoreId || !testProductId) {
        throw new Error('Prerequisites not met');
      }

      // Populate the cart that the order creation will read from.
      // The route resolves items via the session-linked cart, NOT from the body.
      await CartService.addItem(testStoreId, TEST_SESSION_ID, testProductId, 2);

      const res = await request(app)
        .post(`/stores/${testStoreId}/orders`)
        .set('Authorization', `Bearer ${authToken}`)
        .set('x-session-id', TEST_SESSION_ID)
        .send({
          shippingAddress: {
            firstName: 'Test',
            lastName: 'Customer',
            address1: '123 Test Street',
            city: 'Kuwait City',
            country: 'Kuwait',
            phone: '+96512345678',
          },
          paymentMethod: 'cod',
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.order.orderNumber).toBeDefined();
      // 2 items × 5000 fils each
      expect(res.body.data.order.total).toBeGreaterThanOrEqual(10000);

      createdOrderId = res.body.data.order.id;
    });

    it('should calculate order total correctly', async () => {
      if (!createdOrderId) {
        throw new Error('No order created');
      }

      const order = await prisma.order.findUnique({
        where: { id: createdOrderId },
        include: { items: true },
      });

      expect(order).toBeDefined();
      const calculatedTotal = order!.items.reduce(
        (sum, item) => sum + item.price * item.quantity,
        0
      );
      // total = items subtotal + tax + shipping - discount
      expect(order!.total).toBeGreaterThanOrEqual(calculatedTotal);
    });

    it('should reduce inventory on order creation', async () => {
      if (!testProductId) {
        throw new Error('No product available');
      }

      const product = await prisma.product.findUnique({
        where: { id: testProductId },
      });

      // Initial was 100, order took 2
      expect(product?.inventory).toBe(98);
    });

    it('should reject order when cart is empty', async () => {
      if (!authToken || !testStoreId) {
        throw new Error('Prerequisites not met');
      }

      // Use a fresh session with no cart items
      const emptySessionId = `test-empty-session-${Date.now()}`;

      const res = await request(app)
        .post(`/stores/${testStoreId}/orders`)
        .set('Authorization', `Bearer ${authToken}`)
        .set('x-session-id', emptySessionId)
        .send({
          shippingAddress: {
            firstName: 'Test',
            lastName: 'Customer',
            address1: '123 Test Street',
            city: 'Kuwait City',
            country: 'Kuwait',
            phone: '+96512345678',
          },
          paymentMethod: 'cod',
        });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      // Empty cart produces EMPTY_CART error from OrderService
      expect(res.body.error.code).toBe('EMPTY_CART');
    });

    it('should reject order without session ID', async () => {
      if (!authToken || !testStoreId) {
        throw new Error('Prerequisites not met');
      }

      const res = await request(app)
        .post(`/stores/${testStoreId}/orders`)
        .set('Authorization', `Bearer ${authToken}`)
        // Intentionally omit x-session-id header
        .send({
          shippingAddress: {
            firstName: 'Test',
            lastName: 'Customer',
            address1: '123 Test Street',
            city: 'Kuwait City',
            country: 'Kuwait',
            phone: '+96512345678',
          },
          paymentMethod: 'cod',
        });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });
  });

  describe('GET /stores/:storeId/orders/:id', () => {
    it('should retrieve order with items', async () => {
      if (!authToken || !createdOrderId || !testStoreId) {
        throw new Error('Prerequisites not met');
      }

      const res = await request(app)
        .get(`/stores/${testStoreId}/orders/${createdOrderId}`)
        .set('Authorization', `Bearer ${authToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.order.items).toHaveLength(1);
      expect(res.body.data.order.items[0].quantity).toBe(2);
    });
  });

  describe('Order Status Updates', () => {
    it('should update order status', async () => {
      if (!authToken || !createdOrderId || !testStoreId) {
        throw new Error('Prerequisites not met');
      }

      const res = await request(app)
        .put(`/stores/${testStoreId}/orders/${createdOrderId}/status`)
        .set('Authorization', `Bearer ${authToken}`)
        .send({ status: 'processing' });

      expect(res.status).toBe(200);
      expect(res.body.data.order.status).toBe('processing');
    });

    it('should persist updated order status in DB', async () => {
      if (!createdOrderId) {
        throw new Error('No order available');
      }

      const order = await prisma.order.findUnique({
        where: { id: createdOrderId },
      });

      // Status was updated to 'processing' in the previous test
      expect(order?.status).toBe('processing');
    });
  });

  describe('Payment Webhook Idempotency', () => {
    it('should handle duplicate webhook calls', async () => {
      if (!createdOrderId) {
        throw new Error('No order available');
      }

      // Get the order
      const order = await prisma.order.findUnique({
        where: { id: createdOrderId },
      });

      // Simulate webhook payload
      const webhookPayload = {
        id: `tap_${Date.now()}`,
        object: 'charge',
        status: 'CAPTURED',
        reference: {
          order: order?.orderNumber,
        },
        metadata: {
          orderId: createdOrderId,
        },
      };

      // First webhook call
      const res1 = await request(app)
        .post('/webhooks/payment/tap')
        .set('x-tap-signature', 'test-signature')
        .send(webhookPayload);

      expect(res1.status).toBe(200);

      // Second webhook call (duplicate) - should be handled gracefully
      const res2 = await request(app)
        .post('/webhooks/payment/tap')
        .set('x-tap-signature', 'test-signature')
        .send(webhookPayload);

      expect(res2.status).toBe(200);
      expect(res2.body.data.message).toContain('already processed');
    });

    it('should reject invalid payment provider', async () => {
      const res = await request(app)
        .post('/webhooks/payment/invalid-provider')
        .send({ data: 'test' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_PROVIDER');
    });
  });

  describe('Order Cancellation', () => {
    it('should cancel order and restore inventory', async () => {
      if (!authToken || !testStoreId || !testProductId) {
        throw new Error('Prerequisites not met');
      }

      // Get current inventory
      const productBefore = await prisma.product.findUnique({
        where: { id: testProductId },
      });
      const inventoryBefore = productBefore?.inventory ?? 0;

      // Create a fresh session and add items to the cart for this order
      const cancelSessionId = `test-cancel-session-${Date.now()}`;
      await CartService.addItem(testStoreId, cancelSessionId, testProductId!, 5);

      // Create a new order to cancel
      const createRes = await request(app)
        .post(`/stores/${testStoreId}/orders`)
        .set('Authorization', `Bearer ${authToken}`)
        .set('x-session-id', cancelSessionId)
        .send({
          shippingAddress: {
            firstName: 'Test',
            lastName: 'Cancel',
            address1: '123 Test Street',
            city: 'Kuwait City',
            country: 'Kuwait',
            phone: '+96512345678',
          },
          paymentMethod: 'cod',
        });

      expect(createRes.status).toBe(201);
      const cancelOrderId = createRes.body.data.order.id;

      // Cancel the order via the status endpoint (no separate /cancel route)
      const cancelRes = await request(app)
        .put(`/stores/${testStoreId}/orders/${cancelOrderId}/status`)
        .set('Authorization', `Bearer ${authToken}`)
        .send({ status: 'cancelled' });

      expect(cancelRes.status).toBe(200);
      expect(cancelRes.body.data.order.status).toBe('cancelled');

      // Verify inventory was restored
      const productAfter = await prisma.product.findUnique({
        where: { id: testProductId },
      });

      // Should be back to inventory before this order
      expect(productAfter?.inventory).toBe(inventoryBefore);

      // Cleanup
      await prisma.orderItem.deleteMany({ where: { orderId: cancelOrderId } });
      await prisma.order.delete({ where: { id: cancelOrderId } }).catch(() => {});
      // Cleanup cancel session cart
      await prisma.cartItem.deleteMany({
        where: { cart: { storeId: testStoreId, sessionId: cancelSessionId } },
      });
      await prisma.cart.deleteMany({
        where: { storeId: testStoreId, sessionId: cancelSessionId },
      });
    });
  });
});
