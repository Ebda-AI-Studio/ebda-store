/**
 * Checkout Flow E2E Tests
 * Tests complete checkout flow: cart -> checkout -> payment
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express, { Router } from 'express';
import { prisma } from '@force/database';
import cartRoutes from '@api/routes/cart.routes';
import orderRoutes from '@api/routes/order.routes';
import publicRoutes from '@api/routes/public.routes';
import authRoutes from '@api/routes/auth.routes';
import { errorHandler } from '@api/middleware/error-handler';
import { authenticate } from '@api/middleware/auth';
import bcrypt from 'bcryptjs';

const app = express();
app.use(express.json());
app.use('/auth', authRoutes);
app.use('/public', publicRoutes);
const storeRouter = Router({ mergeParams: true });
storeRouter.use('/:storeId/cart', cartRoutes);
storeRouter.use('/:storeId/orders', authenticate, orderRoutes);
app.use('/stores', storeRouter);
app.use(errorHandler);

// Test data
let testStoreId: string | null = null;
let testUserId: string | null = null;
let testProductId: string | null = null;
let testProduct2Id: string | null = null;
let testCustomerId: string | null = null;
let authToken: string | null = null;

const TEST_SESSION_ID = `test-session-${Date.now()}`;

describe('Checkout Flow', () => {
  beforeAll(async () => {
    // Create test user
    const hashedPassword = await bcrypt.hash('Test123!@#', 12);

    const user = await prisma.user.create({
      data: {
        email: `checkout-test-${Date.now()}@example.com`,
        passwordHash: hashedPassword,
        firstName: 'Checkout',
        lastName: 'Tester',
        role: 'super_admin',
        emailVerified: true,
      },
    });
    testUserId = user.id;

    // Create test store
    const store = await prisma.store.create({
      data: {
        name: 'Checkout Test Store',
        slug: `checkout-test-store-${Date.now()}`,
        ownerId: user.id,
        status: 'active',
        currency: 'KWD',
      },
    });
    testStoreId = store.id;

    // Create test products
    const product1 = await prisma.product.create({
      data: {
        storeId: store.id,
        name: 'Checkout Product 1',
        slug: `checkout-product-1-${Date.now()}`,
        price: 5000, // 5 KWD
        inventory: 50,
        status: 'active',
      },
    });
    testProductId = product1.id;

    const product2 = await prisma.product.create({
      data: {
        storeId: store.id,
        name: 'Checkout Product 2',
        slug: `checkout-product-2-${Date.now()}`,
        price: 7500, // 7.5 KWD
        inventory: 30,
        status: 'active',
      },
    });
    testProduct2Id = product2.id;

    // Create test customer
    const customer = await prisma.customer.create({
      data: {
        storeId: store.id,
        email: `customer-checkout-${Date.now()}@example.com`,
        firstName: 'Checkout',
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
    await prisma.orderItem.deleteMany({ where: { order: { storeId: testStoreId! } } });
    await prisma.order.deleteMany({ where: { storeId: testStoreId! } });
    await prisma.cartItem.deleteMany({ where: { cart: { storeId: testStoreId! } } });
    await prisma.cart.deleteMany({ where: { storeId: testStoreId! } });
    if (testProduct2Id) {
      await prisma.product.delete({ where: { id: testProduct2Id } }).catch(() => {});
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

  describe('Cart Operations', () => {
    let cartId: string | null = null;

    it('should create a new cart', async () => {
      if (!testStoreId) throw new Error('Store not created');

      const res = await request(app)
        .post(`/stores/${testStoreId}/cart`)
        .set('x-session-id', TEST_SESSION_ID)
        .send({ storeId: testStoreId });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.id).toBeDefined();
      expect(res.body.data.storeId).toBe(testStoreId);

      cartId = res.body.data.id;
    });

    it('should add item to cart', async () => {
      if (!cartId || !testProductId) throw new Error('Prerequisites not met');

      const res = await request(app)
        .post(`/stores/${testStoreId}/cart/${cartId}/items`)
        .set('x-session-id', TEST_SESSION_ID)
        .send({
          productId: testProductId,
          quantity: 2,
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.items).toHaveLength(1);
      expect(res.body.data.items[0].productId).toBe(testProductId);
      expect(res.body.data.items[0].quantity).toBe(2);
    });

    it('should add second item to cart', async () => {
      if (!cartId || !testProduct2Id) throw new Error('Prerequisites not met');

      const res = await request(app)
        .post(`/stores/${testStoreId}/cart/${cartId}/items`)
        .set('x-session-id', TEST_SESSION_ID)
        .send({
          productId: testProduct2Id,
          quantity: 1,
        });

      expect(res.status).toBe(200);
      expect(res.body.data.items).toHaveLength(2);
    });

    it('should update item quantity', async () => {
      if (!cartId || !testProductId) throw new Error('Prerequisites not met');

      const res = await request(app)
        .put(`/stores/${testStoreId}/cart/${cartId}/items/${testProductId}`)
        .set('x-session-id', TEST_SESSION_ID)
        .send({ quantity: 3 });

      expect(res.status).toBe(200);
      const item = res.body.data.items.find((i: any) => i.productId === testProductId);
      expect(item.quantity).toBe(3);
    });

    it('should calculate cart totals correctly', async () => {
      if (!cartId) throw new Error('Cart not created');

      const res = await request(app)
        .get(`/stores/${testStoreId}/cart/${cartId}`)
        .set('x-session-id', TEST_SESSION_ID);

      expect(res.status).toBe(200);
      // 3 x 5000 + 1 x 7500 = 22500
      expect(res.body.data.subtotal).toBe(22500);
    });

    it('should remove item from cart', async () => {
      if (!cartId || !testProduct2Id) throw new Error('Prerequisites not met');

      const res = await request(app)
        .delete(`/stores/${testStoreId}/cart/${cartId}/items/${testProduct2Id}`)
        .set('x-session-id', TEST_SESSION_ID);

      expect(res.status).toBe(200);
      expect(res.body.data.items).toHaveLength(1);
    });

    it('should reject adding item with insufficient inventory', async () => {
      if (!cartId || !testProductId) throw new Error('Prerequisites not met');

      const res = await request(app)
        .put(`/stores/${testStoreId}/cart/${cartId}/items/${testProductId}`)
        .set('x-session-id', TEST_SESSION_ID)
        .send({ quantity: 1000 }); // More than available

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INSUFFICIENT_INVENTORY');
    });

    it('should convert cart to order at checkout', async () => {
      if (!cartId || !authToken || !testCustomerId) throw new Error('Prerequisites not met');

      const res = await request(app)
        .post(`/stores/${testStoreId}/cart/${cartId}/checkout`)
        .set('Authorization', `Bearer ${authToken}`)
        .set('x-session-id', TEST_SESSION_ID)
        .send({
          customerId: testCustomerId,
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

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.order).toBeDefined();
      expect(res.body.data.order.orderNumber).toBeDefined();
      expect(res.body.data.order.status).toBe('pending');
    });
  });

  describe('Coupon Application', () => {
    let cartId: string | null = null;
    let couponId: string | null = null;

    beforeAll(async () => {
      // Create a coupon
      const coupon = await prisma.coupon.create({
        data: {
          storeId: testStoreId!,
          code: `TEST-${Date.now()}`,
          name: 'Test Coupon',
          // schema renamed these fields — value/minOrderAmount/expires* —
          // mirror the production model exactly here.
          type: 'percentage',
          value: 10, // 10% off
          minOrderAmount: 5000,
          usageLimit: 100,
          usageCount: 0,
          isActive: true,
          startsAt: new Date(Date.now() - 86400000),
          expiresAt: new Date(Date.now() + 86400000),
        },
      });
      couponId = coupon.id;
    });

    afterAll(async () => {
      if (couponId) {
        await prisma.coupon.delete({ where: { id: couponId } }).catch(() => {});
      }
    });

    it('should create cart for coupon test', async () => {
      const res = await request(app)
        .post(`/stores/${testStoreId}/cart`)
        .set('x-session-id', TEST_SESSION_ID)
        .send({ storeId: testStoreId });

      expect(res.status).toBe(201);
      cartId = res.body.data.id;

      // Add item
      await request(app)
        .post(`/stores/${testStoreId}/cart/${cartId}/items`)
        .set('x-session-id', TEST_SESSION_ID)
        .send({
          productId: testProductId,
          quantity: 2,
        });
    });

    it('should apply valid coupon to cart', async () => {
      if (!cartId) throw new Error('Cart not created');

      const coupon = await prisma.coupon.findUnique({ where: { id: couponId! } });

      const res = await request(app)
        .post(`/stores/${testStoreId}/cart/${cartId}/coupon`)
        .set('x-session-id', TEST_SESSION_ID)
        .send({ code: coupon?.code });

      expect(res.status).toBe(200);
      expect(res.body.data.coupon).toBeDefined();
      expect(res.body.data.discount).toBeGreaterThan(0);
      // 10% of 10000 (2 x 5000) = 1000
      expect(res.body.data.discount).toBe(1000);
    });

    it('should reject invalid coupon code', async () => {
      if (!cartId) throw new Error('Cart not created');

      const res = await request(app)
        .post(`/stores/${testStoreId}/cart/${cartId}/coupon`)
        .set('x-session-id', TEST_SESSION_ID)
        .send({ code: 'INVALID-CODE' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_COUPON');
    });

    it('should reject expired coupon', async () => {
      // Create expired coupon
      const expiredCoupon = await prisma.coupon.create({
        data: {
          storeId: testStoreId!,
          code: `EXPIRED-${Date.now()}`,
          name: 'Test Coupon Expired',
          type: 'fixed',
          value: 500,
          isActive: true,
          startsAt: new Date(Date.now() - 86400000 * 2),
          expiresAt: new Date(Date.now() - 86400000), // Expired yesterday
        },
      });

      const res = await request(app)
        .post(`/stores/${testStoreId}/cart/${cartId}/coupon`)
        .set('x-session-id', TEST_SESSION_ID)
        .send({ code: expiredCoupon.code });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('COUPON_EXPIRED');

      // Cleanup
      await prisma.coupon.delete({ where: { id: expiredCoupon.id } });
    });

    it('should reject coupon below minimum order value', async () => {
      // Create cart with low value
      const lowValueCart = await request(app)
        .post(`/stores/${testStoreId}/cart`)
        .set('x-session-id', TEST_SESSION_ID)
        .send({ storeId: testStoreId });

      const lowCartId = lowValueCart.body.data.id;

      // Add cheap item (create one with low price first)
      const cheapProduct = await prisma.product.create({
        data: {
          storeId: testStoreId!,
          name: 'Cheap Product',
          slug: `cheap-${Date.now()}`,
          price: 100, // Very low price
          inventory: 10,
          status: 'active',
        },
      });

      await request(app)
        .post(`/stores/${testStoreId}/cart/${lowCartId}/items`)
        .set('x-session-id', TEST_SESSION_ID)
        .send({
          productId: cheapProduct.id,
          quantity: 1,
        });

      const coupon = await prisma.coupon.findUnique({ where: { id: couponId! } });

      const res = await request(app)
        .post(`/stores/${testStoreId}/cart/${lowCartId}/coupon`)
        .set('x-session-id', TEST_SESSION_ID)
        .send({ code: coupon?.code });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('MIN_ORDER_NOT_MET');

      // Cleanup
      await prisma.cartItem.deleteMany({ where: { cartId: lowCartId } });
      await prisma.cart.delete({ where: { id: lowCartId } });
      await prisma.product.delete({ where: { id: cheapProduct.id } });
    });

    it('should remove coupon from cart', async () => {
      if (!cartId) throw new Error('Cart not created');

      const res = await request(app)
        .delete(`/stores/${testStoreId}/cart/${cartId}/coupon`)
        .set('x-session-id', TEST_SESSION_ID);

      expect(res.status).toBe(200);
      expect(res.body.data.coupon).toBeNull();
      expect(res.body.data.discount).toBe(0);
    });
  });

  describe('Shipping Calculation', () => {
    let cartId: string | null = null;

    beforeAll(async () => {
      // Create cart
      const res = await request(app)
        .post(`/stores/${testStoreId}/cart`)
        .set('x-session-id', TEST_SESSION_ID)
        .send({ storeId: testStoreId });
      cartId = res.body.data.id;

      // Add items
      await request(app)
        .post(`/stores/${testStoreId}/cart/${cartId}/items`)
        .set('x-session-id', TEST_SESSION_ID)
        .send({
          productId: testProductId,
          quantity: 1,
        });
    });

    it('should calculate shipping based on location', async () => {
      if (!cartId) throw new Error('Cart not created');

      const res = await request(app)
        .post(`/stores/${testStoreId}/cart/${cartId}/shipping`)
        .set('x-session-id', TEST_SESSION_ID)
        .send({
          country: 'Kuwait',
          city: 'Kuwait City',
        });

      expect(res.status).toBe(200);
      expect(res.body.data.shippingOptions).toBeDefined();
      expect(Array.isArray(res.body.data.shippingOptions)).toBe(true);
    });

    it('should apply selected shipping to cart', async () => {
      if (!cartId) throw new Error('Cart not created');

      const res = await request(app)
        .put(`/stores/${testStoreId}/cart/${cartId}/shipping`)
        .set('x-session-id', TEST_SESSION_ID)
        .send({
          shippingMethod: 'standard',
          shippingCost: 1500, // 1.5 KWD
        });

      expect(res.status).toBe(200);
      expect(res.body.data.shippingCost).toBe(1500);
      // Total should be item cost + shipping
      expect(res.body.data.total).toBe(5000 + 1500);
    });
  });

  describe('Guest Checkout', () => {
    it('should allow checkout without authentication', async () => {
      // Create cart
      const cartRes = await request(app)
        .post(`/stores/${testStoreId}/cart`)
        .set('x-session-id', TEST_SESSION_ID)
        .send({ storeId: testStoreId });

      const cartId = cartRes.body.data.id;

      // Add item
      await request(app)
        .post(`/stores/${testStoreId}/cart/${cartId}/items`)
        .set('x-session-id', TEST_SESSION_ID)
        .send({
          productId: testProductId,
          quantity: 1,
        });

      // Checkout as guest (no auth token)
      const res = await request(app)
        .post(`/stores/${testStoreId}/cart/${cartId}/checkout`)
        .set('x-session-id', TEST_SESSION_ID)
        .send({
          guestEmail: 'guest@example.com',
          shippingAddress: {
            firstName: 'Guest',
            lastName: 'User',
            address: '456 Guest Street',
            city: 'Hawally',
            country: 'Kuwait',
            phone: '+96587654321',
          },
          paymentMethod: 'cod',
        });

      expect(res.status).toBe(201);
      expect(res.body.data.order).toBeDefined();
      expect(res.body.data.order.guestEmail).toBe('guest@example.com');

      // Cleanup
      await prisma.orderItem.deleteMany({ where: { orderId: res.body.data.order.id } });
      await prisma.order.delete({ where: { id: res.body.data.order.id } });
    });
  });
});
