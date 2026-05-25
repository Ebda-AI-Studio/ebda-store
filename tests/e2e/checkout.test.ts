/**
 * Checkout Flow E2E Tests
 * Tests complete checkout flow: cart -> checkout -> payment
 *
 * Cart routes are session-based (x-session-id header), NOT cart-ID-based.
 * Cart item updates/deletes use the CartItem row ID, not the product ID.
 * Checkout (cart → order) is POST /stores/:storeId/orders on the order router.
 * Coupon validation lives on public routes; shipping/coupon-apply are not
 * standalone cart-level endpoints — skipped here.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express, { Router } from 'express';
import { prisma } from '@force/database';
import cartRoutes from '@api/routes/cart.routes';
import orderRoutes from '@api/routes/order.routes';
import couponRoutes from '@api/routes/coupon.routes';
import publicRoutes from '@api/routes/public.routes';
import authRoutes from '@api/routes/auth.routes';
import { errorHandler } from '@api/middleware/error-handler';
import { authenticate } from '@api/middleware/auth';
import bcrypt from 'bcryptjs';

const app = express();
app.use(express.json());
app.use('/auth', authRoutes);
app.use('/public', publicRoutes);
app.use('/', couponRoutes);
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
    let firstItemId: string | null = null;
    let secondItemId: string | null = null;

    it('should create a new cart', async () => {
      if (!testStoreId) throw new Error('Store not created');

      const res = await request(app)
        .get(`/stores/${testStoreId}/cart`)
        .set('x-session-id', TEST_SESSION_ID);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.cart.id).toBeDefined();
      expect(res.body.data.cart.storeId).toBe(testStoreId);
    });

    it('should add item to cart', async () => {
      if (!testProductId) throw new Error('Prerequisites not met');

      const res = await request(app)
        .post(`/stores/${testStoreId}/cart/items`)
        .set('x-session-id', TEST_SESSION_ID)
        .send({
          productId: testProductId,
          quantity: 2,
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.cart.items).toHaveLength(1);
      expect(res.body.data.cart.items[0].quantity).toBe(2);

      firstItemId = res.body.data.cart.items[0].id;
    });

    it('should add second item to cart', async () => {
      if (!testProduct2Id) throw new Error('Prerequisites not met');

      const res = await request(app)
        .post(`/stores/${testStoreId}/cart/items`)
        .set('x-session-id', TEST_SESSION_ID)
        .send({
          productId: testProduct2Id,
          quantity: 1,
        });

      expect(res.status).toBe(201);
      expect(res.body.data.cart.items).toHaveLength(2);

      const item2 = res.body.data.cart.items.find((i: any) => i.id !== firstItemId);
      secondItemId = item2?.id ?? null;
    });

    it('should update item quantity', async () => {
      if (!firstItemId) throw new Error('Prerequisites not met');

      const res = await request(app)
        .put(`/stores/${testStoreId}/cart/items/${firstItemId}`)
        .set('x-session-id', TEST_SESSION_ID)
        .send({ quantity: 3 });

      expect(res.status).toBe(200);
      const item = res.body.data.cart.items.find((i: any) => i.id === firstItemId);
      expect(item.quantity).toBe(3);
    });

    it('should calculate cart totals correctly', async () => {
      const res = await request(app)
        .get(`/stores/${testStoreId}/cart`)
        .set('x-session-id', TEST_SESSION_ID);

      expect(res.status).toBe(200);
      // 3 x 5000 + 1 x 7500 = 22500
      expect(res.body.data.cart.subtotal).toBe(22500);
    });

    it('should remove item from cart', async () => {
      if (!secondItemId) throw new Error('Prerequisites not met');

      const res = await request(app)
        .delete(`/stores/${testStoreId}/cart/items/${secondItemId}`)
        .set('x-session-id', TEST_SESSION_ID);

      expect(res.status).toBe(200);
      expect(res.body.data.cart.items).toHaveLength(1);
    });

    it('should reject adding item with insufficient inventory', async () => {
      if (!firstItemId) throw new Error('Prerequisites not met');

      const res = await request(app)
        .put(`/stores/${testStoreId}/cart/items/${firstItemId}`)
        .set('x-session-id', TEST_SESSION_ID)
        .send({ quantity: 1000 }); // More than available

      expect(res.status).toBe(400);
    });

    it('should convert cart to order at checkout', async () => {
      if (!authToken) throw new Error('Prerequisites not met');

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
      expect(res.body.data.order).toBeDefined();
      expect(res.body.data.order.orderNumber).toBeDefined();
    });
  });

  describe('Coupon Validation', () => {
    let couponId: string | null = null;
    let couponCode: string | null = null;

    beforeAll(async () => {
      const coupon = await prisma.coupon.create({
        data: {
          storeId: testStoreId!,
          code: `TEST-${Date.now()}`,
          name: 'Test Coupon',
          type: 'percentage',
          value: 10,
          minOrderAmount: 5000,
          usageLimit: 100,
          usageCount: 0,
          isActive: true,
          startsAt: new Date(Date.now() - 86400000),
          expiresAt: new Date(Date.now() + 86400000),
        },
      });
      couponId = coupon.id;
      couponCode = coupon.code;
    });

    afterAll(async () => {
      if (couponId) {
        await prisma.coupon.delete({ where: { id: couponId } }).catch(() => {});
      }
    });

    it('should validate a valid coupon via public endpoint', async () => {
      if (!couponCode || !testStoreId) throw new Error('Prerequisites not met');

      const res = await request(app)
        .post(`/public/${testStoreId}/coupons/validate`)
        .send({ code: couponCode, orderTotal: 10000 });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.coupon).toBeDefined();
      expect(res.body.data.discount).toBe(1000);
    });

    it('should reject invalid coupon code', async () => {
      if (!testStoreId) throw new Error('Prerequisites not met');

      const res = await request(app)
        .post(`/public/${testStoreId}/coupons/validate`)
        .send({ code: 'INVALID-CODE', orderTotal: 10000 });

      expect(res.status).toBe(404);
    });

    it('should reject expired coupon', async () => {
      if (!testStoreId) throw new Error('Prerequisites not met');

      const expiredCoupon = await prisma.coupon.create({
        data: {
          storeId: testStoreId!,
          code: `EXPIRED-${Date.now()}`,
          name: 'Test Coupon Expired',
          type: 'fixed',
          value: 500,
          isActive: true,
          startsAt: new Date(Date.now() - 86400000 * 2),
          expiresAt: new Date(Date.now() - 86400000),
        },
      });

      const res = await request(app)
        .post(`/public/${testStoreId}/coupons/validate`)
        .send({ code: expiredCoupon.code, orderTotal: 10000 });

      expect(res.status).toBe(400);

      await prisma.coupon.delete({ where: { id: expiredCoupon.id } });
    });

    it('should reject coupon below minimum order value', async () => {
      if (!testStoreId || !couponCode) throw new Error('Prerequisites not met');

      const res = await request(app)
        .post(`/public/${testStoreId}/coupons/validate`)
        .send({ code: couponCode, orderTotal: 100 });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('MIN_ORDER_NOT_MET');
    });
  });

  describe('Shipping Calculation', () => {
    it.skip('should calculate shipping based on location', () => {
      // Shipping calculation is not exposed as a standalone cart endpoint.
      // Shipping options are resolved during order creation flow.
    });

    it.skip('should apply selected shipping to cart', () => {
      // See above — shipping is part of order creation, not a cart mutation.
    });
  });

  describe('Guest Checkout', () => {
    it.skip('should allow checkout without authentication', () => {
      // Guest checkout requires a public order creation endpoint.
      // The mounted order routes use `authenticate` middleware.
      // Guest checkout flow goes through a different route in production.
    });
  });
});
