/**
 * Product Management E2E Tests
 * Tests critical product flows: CRUD, inventory, multi-tenancy
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express, { Router } from 'express';
import { prisma } from '@force/database';
import productRoutes from '@api/routes/product.routes';
import authRoutes from '@api/routes/auth.routes';
import mfaRoutes from '@api/routes/mfa.routes';
import { errorHandler } from '@api/middleware/error-handler';
import { authenticate } from '@api/middleware/auth';
import { createSuperAdminWithMfa, loginAsSuperAdmin } from './helpers/mfa-login';

const app = express();
app.use(express.json());
app.use('/auth', authRoutes);
app.use('/auth/mfa', mfaRoutes);
const storeRouter = Router({ mergeParams: true });
storeRouter.use('/:storeId/products', authenticate, productRoutes);
app.use('/stores', storeRouter);
app.use(errorHandler);

// Test data
let testStoreId: string | null = null;
let testUserId: string | null = null;
let authToken: string | null = null;
let createdProductId: string | null = null;

describe('Product Management', () => {
  beforeAll(async () => {
    // Create test user with MFA pre-enrolled — super_admin now requires MFA
    const hashedPassword = await import('bcryptjs').then(bcrypt => bcrypt.hash('Test123!@#', 12));

    const user = await createSuperAdminWithMfa({
      email: `product-test-${Date.now()}@example.com`,
      passwordHash: hashedPassword,
      firstName: 'Product',
      lastName: 'Tester',
    });
    testUserId = user.id;

    const store = await prisma.store.create({
      data: {
        name: 'Product Test Store',
        slug: `product-test-store-${Date.now()}`,
        ownerId: user.id,
        status: 'active',
      },
    });
    testStoreId = store.id;

    // Login — completes MFA challenge automatically
    authToken = await loginAsSuperAdmin(app, user.email, 'Test123!@#');
  });

  afterAll(async () => {
    // Cleanup in order (products first, then store, then user)
    if (createdProductId) {
      await prisma.product.delete({ where: { id: createdProductId } }).catch(() => {});
    }
    if (testStoreId) {
      await prisma.store.delete({ where: { id: testStoreId } }).catch(() => {});
    }
    if (testUserId) {
      await prisma.user.delete({ where: { id: testUserId } }).catch(() => {});
    }
    await prisma.$disconnect();
  });

  describe('POST /stores/:storeId/products', () => {
    it('should create a product with required fields', async () => {
      if (!authToken || !testStoreId) {
        throw new Error('Prerequisites not met');
      }

      const productData = {
        name: 'Test Product',
        slug: `test-product-${Date.now()}`,
        price: 10000, // 10 KWD in fils
        inventory: 50,
        status: 'active',
      };

      const res = await request(app)
        .post(`/stores/${testStoreId}/products`)
        .set('Authorization', `Bearer ${authToken}`)
        .send(productData);

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.product.name).toBe(productData.name);
      expect(res.body.data.product.price).toBe(productData.price);
      expect(res.body.data.product.inventory).toBe(productData.inventory);

      createdProductId = res.body.data.product.id;
    });

    it('should validate required price field', async () => {
      if (!authToken || !testStoreId) {
        throw new Error('Prerequisites not met');
      }

      const res = await request(app)
        .post(`/stores/${testStoreId}/products`)
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          name: 'Invalid Product',
          slug: 'invalid-product',
          // Missing price
        });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    it('should reject negative price', async () => {
      if (!authToken || !testStoreId) {
        throw new Error('Prerequisites not met');
      }

      const res = await request(app)
        .post(`/stores/${testStoreId}/products`)
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          name: 'Negative Price Product',
          slug: 'negative-price',
          price: -100,
        });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });
  });

  describe('GET /stores/:storeId/products/:id', () => {
    it('should retrieve a product by ID', async () => {
      if (!authToken || !createdProductId) {
        throw new Error('Prerequisites not met');
      }

      const res = await request(app)
        .get(`/stores/${testStoreId}/products/${createdProductId}`)
        .set('Authorization', `Bearer ${authToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.product.id).toBe(createdProductId);
    });

    it('should return 404 for non-existent product', async () => {
      if (!authToken) {
        throw new Error('Auth token not available');
      }

      const res = await request(app)
        .get(`/stores/${testStoreId}/products/non-existent-id`)
        .set('Authorization', `Bearer ${authToken}`);

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
    });
  });

  describe('PUT /stores/:storeId/products/:id', () => {
    it('should update product details', async () => {
      if (!authToken || !createdProductId) {
        throw new Error('Prerequisites not met');
      }

      const res = await request(app)
        .put(`/stores/${testStoreId}/products/${createdProductId}`)
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          name: 'Updated Product Name',
          price: 15000,
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.product.name).toBe('Updated Product Name');
      expect(res.body.data.product.price).toBe(15000);
    });

    it('should update inventory correctly', async () => {
      if (!authToken || !createdProductId) {
        throw new Error('Prerequisites not met');
      }

      const res = await request(app)
        .put(`/stores/${testStoreId}/products/${createdProductId}`)
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          inventory: 100,
        });

      expect(res.status).toBe(200);
      expect(res.body.data.product.inventory).toBe(100);
    });
  });

  describe('Inventory Management', () => {
    it('should track low stock threshold', async () => {
      if (!authToken || !createdProductId) {
        throw new Error('Prerequisites not met');
      }

      // Set low stock threshold
      await request(app)
        .put(`/stores/${testStoreId}/products/${createdProductId}`)
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          inventory: 5,
          lowStockThreshold: 10,
        });

      const res = await request(app)
        .get(`/stores/${testStoreId}/products/${createdProductId}`)
        .set('Authorization', `Bearer ${authToken}`);

      expect(res.body.data.product.inventory).toBe(5);
      expect(res.body.data.product.lowStockThreshold).toBe(10);
      expect(res.body.data.product.inventory).toBeLessThan(res.body.data.product.lowStockThreshold);
    });
  });

  describe('Product Status', () => {
    it('should change product status', async () => {
      if (!authToken || !createdProductId) {
        throw new Error('Prerequisites not met');
      }

      const res = await request(app)
        .put(`/stores/${testStoreId}/products/${createdProductId}`)
        .set('Authorization', `Bearer ${authToken}`)
        .send({ status: 'draft' });

      expect(res.status).toBe(200);
      expect(res.body.data.product.status).toBe('draft');
    });

    it('should only allow valid status values', async () => {
      if (!authToken || !createdProductId) {
        throw new Error('Prerequisites not met');
      }

      const res = await request(app)
        .put(`/stores/${testStoreId}/products/${createdProductId}`)
        .set('Authorization', `Bearer ${authToken}`)
        .send({ status: 'invalid_status' });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });
  });

  describe('DELETE /stores/:storeId/products/:id', () => {
    it('should soft delete a product', async () => {
      if (!authToken || !createdProductId) {
        throw new Error('Prerequisites not met');
      }

      const res = await request(app)
        .delete(`/stores/${testStoreId}/products/${createdProductId}`)
        .set('Authorization', `Bearer ${authToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      // Verify product is soft deleted
      const product = await prisma.product.findUnique({
        where: { id: createdProductId },
      });
      expect(product?.deletedAt).toBeTruthy();
    });
  });
});
