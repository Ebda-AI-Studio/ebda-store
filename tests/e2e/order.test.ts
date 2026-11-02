/**
 * Order Flow E2E Tests
 * Tests critical order flows: cart, checkout, payment webhook
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express, { Router } from 'express';
import { prisma } from '@ebda/database';
import orderRoutes from '@api/routes/order.routes';
import webhookRoutes from '@api/routes/webhook.routes';
import authRoutes from '@api/routes/auth.routes';
import mfaRoutes from '@api/routes/mfa.routes';
import { CartService } from '@api/services/cart.service';
import { handleOrderRefunded } from '@api/lib/inngest/functions/order-refunded';
import { errorHandler } from '@api/middleware/error-handler';
import { createSuperAdminWithMfa, loginAsSuperAdmin, mintAccessToken } from './helpers/mfa-login';

// Order routes expect mergeParams so req.params.storeId is accessible inside the router.
// Mount under /stores/:storeId/orders matching the production route shape.
const app = express();
app.use('/webhooks', express.raw({ type: '*/*' }), webhookRoutes);
app.use(express.json());
app.use('/auth', authRoutes);
app.use('/auth/mfa', mfaRoutes);
const storeRouter = Router({ mergeParams: true });
storeRouter.use('/:storeId/orders', orderRoutes);
app.use('/stores', storeRouter);
app.use(errorHandler);

// Test data
let testStoreId: string | null = null;
let testUserId: string | null = null;
let testProductId: string | null = null;
let authToken: string | null = null;
let storeAdminId: string | null = null;
let storeAdminToken: string | null = null;
let createdOrderId: string | null = null;
let customerToken: string | null = null;
let testCustomerId: string | null = null;
// Session ID that ties the test cart to the order request
const TEST_SESSION_ID = `test-session-${Date.now()}`;

describe('Order Flow', () => {
  beforeAll(async () => {
    // Create test user with MFA pre-enrolled — super_admin now requires MFA
    const hashedPassword = await import('bcryptjs').then(bcrypt => bcrypt.hash('Test123!@#', 12));

    const user = await createSuperAdminWithMfa({
      email: `order-test-${Date.now()}@example.com`,
      passwordHash: hashedPassword,
      firstName: 'Order',
      lastName: 'Tester',
    });
    testUserId = user.id;

    // Store-order status transitions are the merchant's to run (ruling
    // ORDER-MONEY-SUPERADMIN): the store is owned by a store_admin, not the
    // super_admin fixture above, so the status-update tests exercise the
    // real authorization path instead of super_admin's blanket access.
    const storeAdminPassword = 'Test123!@#StoreAdmin';
    const storeAdminHashedPassword = await import('bcryptjs').then(bcrypt =>
      bcrypt.hash(storeAdminPassword, 12)
    );
    const storeAdminEmail = `order-test-store-admin-${Date.now()}@example.com`;
    const storeAdmin = await prisma.user.create({
      data: {
        email: storeAdminEmail,
        passwordHash: storeAdminHashedPassword,
        firstName: 'Order',
        lastName: 'StoreAdmin',
        role: 'store_admin',
        status: 'active',
        emailVerified: true,
      },
    });
    storeAdminId = storeAdmin.id;
    storeAdminToken = mintAccessToken({
      id: storeAdmin.id,
      email: storeAdminEmail,
      role: 'store_admin',
    });

    // Create test store
    const store = await prisma.store.create({
      data: {
        name: 'Order Test Store',
        slug: `order-test-store-${Date.now()}`,
        ownerId: storeAdmin.id,
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
        price: 5000, // 5 EGP in piastres
        inventory: 100,
        status: 'active',
      },
    });
    testProductId = product.id;

    // Login — completes MFA challenge automatically
    authToken = await loginAsSuperAdmin(app, user.email, 'Test123!@#');

    // Separate CUSTOMER identity for checkout. POST /stores/:storeId/orders is
    // the signed-in customer checkout and now rejects non-customer tokens via
    // customerUserId() — admin-created orders belong on POST .../orders/admin.
    // This suite previously checked out with the super_admin token, which is
    // exactly the mis-attribution that guard exists to stop (the order's
    // customerId pointed at a non-customer user row).
    const customerEmail = `order-test-customer-${Date.now()}@example.com`;
    const customer = await prisma.user.create({
      data: {
        // Customer accounts are store-scoped (@@unique([storeId, email]));
        // admins leave storeId NULL. Login must therefore pass storeId too.
        storeId: store.id,
        email: customerEmail,
        passwordHash: hashedPassword,
        firstName: 'Order',
        lastName: 'Customer',
        role: 'customer',
        emailVerified: true,
      },
    });
    testCustomerId = customer.id;

    const customerLogin = await request(app)
      .post('/auth/login')
      .send({ email: customerEmail, password: 'Test123!@#', storeId: store.id });
    customerToken = customerLogin.body?.data?.accessToken ?? customerLogin.body?.data?.token;
    if (!customerToken) {
      throw new Error(
        `Customer login failed (${customerLogin.status}): ${JSON.stringify(customerLogin.body)}`
      );
    }
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
    if (testCustomerId) {
      await prisma.user.delete({ where: { id: testCustomerId } }).catch(() => {});
    }
    if (testUserId) {
      await prisma.user.delete({ where: { id: testUserId } }).catch(() => {});
    }
    if (storeAdminId) {
      await prisma.user.delete({ where: { id: storeAdminId } }).catch(() => {});
    }
    await prisma.$disconnect();
  });

  describe('POST /stores/:storeId/orders', () => {
    it('should create an order with valid data', async () => {
      if (!customerToken || !testStoreId || !testProductId) {
        throw new Error('Prerequisites not met');
      }

      // Populate the cart that the order creation will read from.
      // The route resolves items via the session-linked cart, NOT from the body.
      await CartService.addItem(testStoreId, TEST_SESSION_ID, testProductId, 2);

      const res = await request(app)
        .post(`/stores/${testStoreId}/orders`)
        .set('Authorization', `Bearer ${customerToken}`)
        .set('x-session-id', TEST_SESSION_ID)
        .send({
          shippingAddress: {
            firstName: 'Test',
            lastName: 'Customer',
            address1: '123 Test Street',
            city: 'Cairo',
            country: 'Egypt',
            phone: '+96512345678',
          },
          paymentMethod: 'cod',
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.order.orderNumber).toBeDefined();
      // 2 items × 5000 piastres each
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
      if (!customerToken || !testStoreId) {
        throw new Error('Prerequisites not met');
      }

      // Use a fresh session with no cart items
      const emptySessionId = `test-empty-session-${Date.now()}`;

      const res = await request(app)
        .post(`/stores/${testStoreId}/orders`)
        .set('Authorization', `Bearer ${customerToken}`)
        .set('x-session-id', emptySessionId)
        .send({
          shippingAddress: {
            firstName: 'Test',
            lastName: 'Customer',
            address1: '123 Test Street',
            city: 'Cairo',
            country: 'Egypt',
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
      if (!customerToken || !authToken || !testStoreId) {
        throw new Error('Prerequisites not met');
      }

      const res = await request(app)
        .post(`/stores/${testStoreId}/orders`)
        .set('Authorization', `Bearer ${customerToken}`)
        // Intentionally omit x-session-id header
        .send({
          shippingAddress: {
            firstName: 'Test',
            lastName: 'Customer',
            address1: '123 Test Street',
            city: 'Cairo',
            country: 'Egypt',
            phone: '+96512345678',
          },
          paymentMethod: 'cod',
        });

      expect(res.status).toBe(500);
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
      if (!storeAdminToken || !createdOrderId || !testStoreId) {
        throw new Error('Prerequisites not met');
      }

      const res = await request(app)
        .put(`/stores/${testStoreId}/orders/${createdOrderId}/status`)
        .set('Authorization', `Bearer ${storeAdminToken}`)
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
    // Duplicate-delivery idempotency ("already processed") is pinned per live gateway in
    // tests/integration/egypt-gateway-webhooks.test.ts. Tap was removed when the Egypt gateways replaced it
    // (5ae935d3f, 2026-10-04), so its endpoint now refuses instead of replaying (Ruling ITEST-9).
    it('refuses a webhook for a removed provider (tap) and leaves the order untouched', async () => {
      if (!createdOrderId) {
        throw new Error('No order available');
      }

      const syntheticKey = `tap_idempotency_test_${Date.now()}`;
      await prisma.order.update({
        where: { id: createdOrderId },
        data: { idempotencyKey: syntheticKey, webhookProcessedAt: new Date() },
      });
      const before = await prisma.order.findUnique({ where: { id: createdOrderId } });

      const webhookPayload = {
        id: syntheticKey.replace(/^tap_/, ''),
        object: 'charge',
        status: 'CAPTURED',
      };

      // Content-Type octet-stream so express.raw({ type: '*/*' }) captures the body as a Buffer.
      const res = await request(app)
        .post('/webhooks/payment/tap')
        .set('x-tap-signature', 'test-signature')
        .set('Content-Type', 'application/octet-stream')
        .send(Buffer.from(JSON.stringify(webhookPayload)));

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_PROVIDER');
      const after = await prisma.order.findUnique({ where: { id: createdOrderId } });
      expect(after?.status).toBe(before?.status);
      expect(after?.paymentStatus).toBe(before?.paymentStatus);
      expect(after?.idempotencyKey).toBe(syntheticKey);
    });

    it('should reject invalid payment provider', async () => {
      const res = await request(app)
        .post('/webhooks/payment/invalid-provider')
        .set('x-signature', 'dummy-signature')
        .set('Content-Type', 'application/octet-stream')
        .send(Buffer.from(JSON.stringify({ data: 'test' })));

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_PROVIDER');
    });
  });

  describe('Order Cancellation', () => {
    let cancelProduct: { id: string } | null = null;

    beforeAll(async () => {
      if (!testStoreId) return;
      cancelProduct = await prisma.product.create({
        data: {
          storeId: testStoreId,
          name: 'Cancel-Test Product',
          slug: `cancel-test-product-${Date.now()}`,
          price: 5000,
          inventory: 100,
          status: 'active',
        },
      });
    });

    afterAll(async () => {
      if (!cancelProduct) return;
      // productId is on CartItem directly (not nested under Cart). Cascade
      // FKs would cover this, but explicit cleanup avoids cross-file teardown
      // race conditions.
      await prisma.cartItem.deleteMany({ where: { productId: cancelProduct.id } });
      await prisma.orderItem.deleteMany({ where: { productId: cancelProduct.id } });
      await prisma.product.delete({ where: { id: cancelProduct.id } }).catch(() => {});
    });

    it('should cancel order and restore inventory', async () => {
      if (!customerToken || !storeAdminToken || !testStoreId || !cancelProduct) {
        throw new Error('Prerequisites not met');
      }

      // Get current inventory before creating the order
      const productBefore = await prisma.product.findUnique({
        where: { id: cancelProduct.id },
      });
      const inventoryBefore = productBefore?.inventory ?? 0;

      // Create a fresh session and add items to the cart for this order
      const cancelSessionId = `test-cancel-session-${Date.now()}`;
      await CartService.addItem(testStoreId, cancelSessionId, cancelProduct.id, 5);

      // Create a new order to cancel
      const createRes = await request(app)
        .post(`/stores/${testStoreId}/orders`)
        .set('Authorization', `Bearer ${customerToken}`)
        .set('x-session-id', cancelSessionId)
        .send({
          shippingAddress: {
            firstName: 'Test',
            lastName: 'Cancel',
            address1: '123 Test Street',
            city: 'Cairo',
            country: 'Egypt',
            phone: '+96512345678',
          },
          paymentMethod: 'cod',
        });

      expect(createRes.status).toBe(201);
      const cancelOrderId = createRes.body.data.order.id;

      // Cancel the order via the status endpoint (no separate /cancel route)
      const cancelRes = await request(app)
        .put(`/stores/${testStoreId}/orders/${cancelOrderId}/status`)
        .set('Authorization', `Bearer ${storeAdminToken}`)
        .send({ status: 'cancelled' });

      expect(cancelRes.status).toBe(200);
      expect(cancelRes.body.data.order.status).toBe('cancelled');

      // Inventory restoration is NOT synchronous with the request. Since #758
      // ("reversals off the request tx, retriable + idempotent") the cancel
      // path only ENQUEUES `order/refunded`; the restore runs in the Inngest
      // fanout. In Node (tests) `inngest.send` starts nothing — there are no Worker
      // bindings — so nothing consumes the event and the restore would never happen.
      //
      // Asserting inventory straight after the response therefore tested a
      // contract the API stopped honouring on 2026-07-16, and this test had
      // been failing ever since (masked by a CI outage, not by passing runs).
      //
      // Rather than weaken the assertion, drive the fanout the same way
      // order.service.ts's own inline fallback does — a stub `step` that runs
      // each step immediately — so the end-to-end intent (cancelling an order
      // returns its stock) is still genuinely verified, deterministically.
      await handleOrderRefunded(cancelOrderId, testStoreId, true, false, {
        run: <T>(_id: string, fn: () => Promise<T>): Promise<T> => fn(),
      });

      // Verify inventory was restored
      const productAfter = await prisma.product.findUnique({
        where: { id: cancelProduct.id },
      });

      // Should be back to inventory before this order
      expect(productAfter?.inventory).toBe(inventoryBefore);

      // Cleanup order rows (product cleanup is in afterAll)
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
