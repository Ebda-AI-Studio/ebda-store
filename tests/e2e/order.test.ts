/**
 * Order Flow E2E Tests
 * Tests critical order flows: cart, checkout, payment webhook
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express from 'express';
import { prisma } from '@force/database';
import orderRoutes from '@api/routes/order.routes';
import webhookRoutes from '@api/routes/webhook.routes';
import authRoutes from '@api/routes/auth.routes';
import { errorHandler } from '@api/middleware/error-handler';
import { authenticate } from '@api/middleware/auth';

const app = express();
app.use(express.json());
app.use('/auth', authRoutes);
app.use('/orders', authenticate, orderRoutes);
app.use('/webhooks', webhookRoutes);
app.use(errorHandler);

// Test data
let testStoreId: string | null = null;
let testUserId: string | null = null;
let testProductId: string | null = null;
let testCustomerId: string | null = null;
let authToken: string | null = null;
let createdOrderId: string | null = null;

describe('Order Flow', () => {
  beforeAll(async () => {
    // Create test user
    const hashedPassword = await import('bcryptjs').then(bcrypt => bcrypt.hash('Test123!@#', 12));

    const user = await prisma.user.create({
      data: {
        email: `order-test-${Date.now()}@example.com`,
        password: hashedPassword,
        firstName: 'Order',
        lastName: 'Tester',
        role: 'super_admin',
        status: 'active',
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
        price: 5000, // 5 KWD
        inventory: 100,
        status: 'active',
      },
    });
    testProductId = product.id;

    // Create test customer
    const customer = await prisma.customer.create({
      data: {
        storeId: store.id,
        email: `customer-${Date.now()}@example.com`,
        firstName: 'Test',
        lastName: 'Customer',
        phone: '+96512345678',
      },
    });
    testCustomerId = customer.id;

    // Login
    const loginRes = await request(app).post('/auth/login').send({
      email: user.email,
      password: 'Test123!@#',
    });
    authToken = loginRes.body.data?.accessToken;
  });

  afterAll(async () => {
    // Cleanup in order
    if (createdOrderId) {
      await prisma.orderItem.deleteMany({ where: { orderId: createdOrderId } });
      await prisma.order.delete({ where: { id: createdOrderId } }).catch(() => {});
    }
    if (testProductId) {
      await prisma.product.delete({ where: { id: testProductId } }).catch(() => {});
    }
    if (testCustomerId) {
      await prisma.customer.delete({ where: { id: testCustomerId } }).catch(() => {});
    }
    if (testStoreId) {
      await prisma.store.delete({ where: { id: testStoreId } }).catch(() => {});
    }
    if (testUserId) {
      await prisma.user.delete({ where: { id: testUserId } }).catch(() => {});
    }
    await prisma.$disconnect();
  });

  describe('POST /orders', () => {
    it('should create an order with valid data', async () => {
      if (!authToken || !testStoreId || !testProductId || !testCustomerId) {
        throw new Error('Prerequisites not met');
      }

      const orderData = {
        storeId: testStoreId,
        customerId: testCustomerId,
        items: [
          {
            productId: testProductId,
            quantity: 2,
            price: 5000,
          },
        ],
        shippingAddress: {
          firstName: 'Test',
          lastName: 'Customer',
          address: '123 Test Street',
          city: 'Kuwait City',
          country: 'Kuwait',
          phone: '+96512345678',
        },
        paymentMethod: 'cod',
      };

      const res = await request(app)
        .post('/orders')
        .set('Authorization', `Bearer ${authToken}`)
        .send(orderData);

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.orderNumber).toBeDefined();
      expect(res.body.data.total).toBe(10000); // 2 x 5000

      createdOrderId = res.body.data.id;
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
      expect(order!.total).toBe(calculatedTotal);
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

    it('should reject order with insufficient inventory', async () => {
      if (!authToken || !testStoreId || !testProductId || !testCustomerId) {
        throw new Error('Prerequisites not met');
      }

      const res = await request(app)
        .post('/orders')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          storeId: testStoreId,
          customerId: testCustomerId,
          items: [
            {
              productId: testProductId,
              quantity: 1000, // More than available
              price: 5000,
            },
          ],
          shippingAddress: {
            firstName: 'Test',
            lastName: 'Customer',
            address: '123 Test Street',
            city: 'Kuwait City',
            country: 'Kuwait',
            phone: '+96512345678',
          },
          paymentMethod: 'cod',
        });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('INSUFFICIENT_INVENTORY');
    });
  });

  describe('GET /orders/:id', () => {
    it('should retrieve order with items', async () => {
      if (!authToken || !createdOrderId) {
        throw new Error('Prerequisites not met');
      }

      const res = await request(app)
        .get(`/orders/${createdOrderId}`)
        .set('Authorization', `Bearer ${authToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.items).toHaveLength(1);
      expect(res.body.data.items[0].quantity).toBe(2);
    });
  });

  describe('Order Status Updates', () => {
    it('should update order status', async () => {
      if (!authToken || !createdOrderId) {
        throw new Error('Prerequisites not met');
      }

      const res = await request(app)
        .put(`/orders/${createdOrderId}/status`)
        .set('Authorization', `Bearer ${authToken}`)
        .send({ status: 'processing' });

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('processing');
    });

    it('should track order status history', async () => {
      if (!createdOrderId) {
        throw new Error('No order available');
      }

      const order = await prisma.order.findUnique({
        where: { id: createdOrderId },
        select: { statusHistory: true },
      });

      expect(order?.statusHistory).toBeDefined();
      // Should have at least initial and processing statuses
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
      if (!authToken || !testStoreId || !testProductId || !testCustomerId) {
        throw new Error('Prerequisites not met');
      }

      // Get current inventory
      const productBefore = await prisma.product.findUnique({
        where: { id: testProductId },
      });
      const inventoryBefore = productBefore?.inventory || 0;

      // Create a new order to cancel
      const createRes = await request(app)
        .post('/orders')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          storeId: testStoreId,
          customerId: testCustomerId,
          items: [
            {
              productId: testProductId,
              quantity: 5,
              price: 5000,
            },
          ],
          shippingAddress: {
            firstName: 'Test',
            lastName: 'Cancel',
            address: '123 Test Street',
            city: 'Kuwait City',
            country: 'Kuwait',
            phone: '+96512345678',
          },
          paymentMethod: 'cod',
        });

      const cancelOrderId = createRes.body.data.id;

      // Cancel the order
      const cancelRes = await request(app)
        .put(`/orders/${cancelOrderId}/cancel`)
        .set('Authorization', `Bearer ${authToken}`);

      expect(cancelRes.status).toBe(200);
      expect(cancelRes.body.data.status).toBe('cancelled');

      // Verify inventory was restored
      const productAfter = await prisma.product.findUnique({
        where: { id: testProductId },
      });

      // Should be back to inventory before this order
      expect(productAfter?.inventory).toBe(inventoryBefore);

      // Cleanup
      await prisma.orderItem.deleteMany({ where: { orderId: cancelOrderId } });
      await prisma.order.delete({ where: { id: cancelOrderId } }).catch(() => {});
    });
  });
});
