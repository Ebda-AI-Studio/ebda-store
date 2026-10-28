/**
 * Public API E2E Tests
 * Tests storefront public endpoints: store resolution, products, categories
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express from 'express';
import { prisma } from '@ebda/database';
import publicRoutes from '@api/routes/public.routes';
import { errorHandler } from '@api/middleware/error-handler';

const app = express();
app.use(express.json());
app.use('/public', publicRoutes);
app.use(errorHandler);

// Test data
let testStoreId: string | null = null;
let testUserId: string | null = null;
let testProductId: string | null = null;
let testCategoryId: string | null = null;
let testCategorySlug: string | null = null;
let testStoreSlug: string | null = null;
let testStoreDomain: string | null = null;

describe('Public Storefront API', () => {
  beforeAll(async () => {
    // Create test user (store owner)
    const user = await prisma.user.create({
      data: {
        email: `public-test-${Date.now()}@example.com`,
        passwordHash: 'not-used-for-public-tests',
        firstName: 'Public',
        lastName: 'Tester',
        role: 'store_admin',
        emailVerified: true,
      },
    });
    testUserId = user.id;

    testStoreSlug = `public-test-store-${Date.now()}`;
    testStoreDomain = `test-${Date.now()}.example.com`;

    // Create test store with domain
    const store = await prisma.store.create({
      data: {
        name: 'Public Test Store',
        nameAr: 'متجر اختبار عام',
        slug: testStoreSlug,
        domain: testStoreDomain,
        // Only a VERIFIED domain resolves (SP5 task 4); this fixture is one.
        domainStatus: 'active',
        ownerId: user.id,
        status: 'active',
        currency: 'EGP',
        template: 'qamar',
        theme: {
          primaryColor: '26 100% 50%',
          fontFamily: 'default',
        },
        socialLinks: {
          instagram: 'https://instagram.com/teststore',
          whatsapp: '+96512345678',
        },
      },
    });
    testStoreId = store.id;

    // Create test category. The Category model has no `status` enum —
    // use the `isActive` boolean instead.
    const category = await prisma.category.create({
      data: {
        storeId: store.id,
        name: 'Test Category',
        nameAr: 'فئة اختبار',
        slug: `test-category-${Date.now()}`,
        isActive: true,
      },
    });
    testCategoryId = category.id;
    testCategorySlug = category.slug;

    // Create test products. Product ↔ Category is a many-to-many join
    // (`ProductCategory`), and images are a separate `ProductImage` table —
    // neither the direct `categoryId` nor an `images: string[]` shortcut
    // exists on the model.
    const product = await prisma.product.create({
      data: {
        storeId: store.id,
        name: 'Public Test Product',
        nameAr: 'منتج اختبار عام',
        slug: `public-test-product-${Date.now()}`,
        description: 'A test product for public API testing',
        price: 5000,
        compareAtPrice: 7500,
        inventory: 50,
        status: 'active',
        categories: { create: [{ categoryId: category.id }] },
        images: {
          create: [
            { url: 'https://example.com/image1.jpg', position: 0 },
            { url: 'https://example.com/image2.jpg', position: 1 },
          ],
        },
      },
    });
    testProductId = product.id;

    // Create a few more products for listing tests
    for (let i = 0; i < 5; i++) {
      await prisma.product.create({
        data: {
          storeId: store.id,
          name: `Additional Product ${i + 1}`,
          slug: `additional-product-${i + 1}-${Date.now()}`,
          price: 3000 + i * 1000,
          inventory: 20,
          status: 'active',
          categories: { create: [{ categoryId: category.id }] },
        },
      });
    }
  });

  afterAll(async () => {
    // Cleanup
    await prisma.product.deleteMany({ where: { storeId: testStoreId! } });
    await prisma.category.deleteMany({ where: { storeId: testStoreId! } });
    if (testStoreId) {
      await prisma.store.delete({ where: { id: testStoreId } }).catch(() => {});
    }
    if (testUserId) {
      await prisma.user.delete({ where: { id: testUserId } }).catch(() => {});
    }
    await prisma.$disconnect();
  });

  describe('Store Resolution', () => {
    it('should resolve store by slug', async () => {
      const res = await request(app).get(`/public/stores/${testStoreSlug}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.store.slug).toBe(testStoreSlug);
      expect(res.body.data.store.name).toBe('Public Test Store');
    });

    it('should resolve store by domain header', async () => {
      const res = await request(app)
        .get('/public/store/resolve')
        .set('x-store-domain', testStoreDomain!);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.store.domain).toBe(testStoreDomain);
    });

    it('should include theme and branding in resolution', async () => {
      const res = await request(app).get(`/public/stores/${testStoreSlug}`);

      expect(res.body.data.store.theme).toBeDefined();
      expect(res.body.data.store.theme.primaryColor).toBe('26 100% 50%');
      expect(res.body.data.store.socialLinks).toBeDefined();
      expect(res.body.data.store.socialLinks.instagram).toBe('https://instagram.com/teststore');
    });

    it('should return 404 for non-existent store', async () => {
      const res = await request(app).get('/public/stores/non-existent-store');

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('STORE_NOT_FOUND');
    });

    it('should not expose sensitive store data', async () => {
      const res = await request(app).get(`/public/stores/${testStoreSlug}`);

      // Should not include internal fields
      expect(res.body.data.store.ownerId).toBeUndefined();
      expect(res.body.data.store.paymentConfig).toBeUndefined();
    });
  });

  describe('Product Listing', () => {
    it('should list active products for store', async () => {
      const res = await request(app).get('/public/products').set('x-store-id', testStoreId!);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.products).toBeDefined();
      expect(res.body.data.products.length).toBeGreaterThan(0);
      expect(res.body.data.meta).toBeDefined();
    });

    it('should paginate products correctly', async () => {
      const res = await request(app)
        .get('/public/products')
        .set('x-store-id', testStoreId!)
        .query({ page: 1, limit: 3 });

      expect(res.status).toBe(200);
      expect(res.body.data.products.length).toBeLessThanOrEqual(3);
      expect(res.body.data.meta.page).toBe(1);
      expect(res.body.data.meta.limit).toBe(3);
      expect(res.body.data.meta.total).toBeGreaterThan(3);
    });

    it('should filter products by category', async () => {
      const res = await request(app)
        .get('/public/products')
        .set('x-store-id', testStoreId!)
        // listPublic filters by category SLUG (see product.service.ts:584),
        // not categoryId. Pass slug here to match.
        .query({ category: testCategorySlug });

      expect(res.status).toBe(200);
      expect(res.body.data.products.length).toBeGreaterThan(0);
    });

    it('should sort products by price', async () => {
      const res = await request(app)
        .get('/public/products')
        .set('x-store-id', testStoreId!)
        .query({ sort: 'price_asc' });

      expect(res.status).toBe(200);
      const prices = res.body.data.products.map((p: any) => p.price);
      expect(prices).toEqual([...prices].sort((a, b) => a - b));
    });

    it('should search products by name', async () => {
      const res = await request(app)
        .get('/public/products')
        .set('x-store-id', testStoreId!)
        .query({ search: 'Public Test' });

      expect(res.status).toBe(200);
      expect(res.body.data.products.length).toBeGreaterThan(0);
      expect(res.body.data.products[0].name).toContain('Public Test');
    });

    it('should filter products by price range', async () => {
      const res = await request(app)
        .get('/public/products')
        .set('x-store-id', testStoreId!)
        .query({ minPrice: 4000, maxPrice: 6000 });

      expect(res.status).toBe(200);
      res.body.data.products.forEach((product: any) => {
        expect(product.price).toBeGreaterThanOrEqual(4000);
        expect(product.price).toBeLessThanOrEqual(6000);
      });
    });
  });

  describe('Single Product', () => {
    it('should get product by slug', async () => {
      const product = await prisma.product.findUnique({ where: { id: testProductId! } });

      const res = await request(app)
        .get(`/public/products/${product?.slug}`)
        .set('x-store-id', testStoreId!);

      expect(res.status).toBe(200);
      expect(res.body.data.product.id).toBe(testProductId);
      expect(res.body.data.product.name).toBe('Public Test Product');
      expect(res.body.data.product.price).toBe(5000);
      expect(res.body.data.product.images).toHaveLength(2);
    });

    it('should include category info in product', async () => {
      const product = await prisma.product.findUnique({ where: { id: testProductId! } });

      const res = await request(app)
        .get(`/public/products/${product?.slug}`)
        .set('x-store-id', testStoreId!);

      expect(res.body.data.product.categories).toBeDefined();
      expect(res.body.data.product.categories.length).toBeGreaterThan(0);
    });

    it('should return 404 for non-existent product', async () => {
      const res = await request(app)
        .get('/public/products/non-existent-product')
        .set('x-store-id', testStoreId!);

      expect(res.status).toBe(404);
    });

    it('should not return draft products', async () => {
      const draftProduct = await prisma.product.create({
        data: {
          storeId: testStoreId!,
          name: 'Draft Product',
          slug: `draft-product-${Date.now()}`,
          price: 1000,
          inventory: 10,
          status: 'draft',
        },
      });

      const res = await request(app)
        .get(`/public/products/${draftProduct.slug}`)
        .set('x-store-id', testStoreId!);

      expect(res.status).toBe(404);

      await prisma.product.delete({ where: { id: draftProduct.id } });
    });
  });

  describe('Category Listing', () => {
    it('should list categories for store', async () => {
      const res = await request(app).get('/public/categories').set('x-store-id', testStoreId!);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.categories).toBeDefined();
      expect(res.body.data.categories.length).toBeGreaterThan(0);
    });

    it('should include product count in categories', async () => {
      const res = await request(app).get('/public/categories').set('x-store-id', testStoreId!);

      const category = res.body.data.categories.find((c: any) => c.id === testCategoryId);
      expect(category).toBeDefined();
      expect(category.productCount).toBeGreaterThan(0);
    });
  });

  describe('Arabic Localization', () => {
    it('should return Arabic content with lang=ar', async () => {
      const res = await request(app)
        .get(`/public/stores/${testStoreSlug}`)
        .set('Accept-Language', 'ar');

      expect(res.status).toBe(200);
      expect(res.body.data.store.nameAr).toBe('متجر اختبار عام');
    });

    it('should return Arabic product names', async () => {
      const product = await prisma.product.findUnique({ where: { id: testProductId! } });

      const res = await request(app)
        .get(`/public/products/${product?.slug}`)
        .set('x-store-id', testStoreId!)
        .set('Accept-Language', 'ar');

      expect(res.body.data.product.nameAr).toBe('منتج اختبار عام');
    });
  });

  describe('Inventory Visibility', () => {
    it('should show in-stock status', async () => {
      const product = await prisma.product.findUnique({ where: { id: testProductId! } });

      const res = await request(app)
        .get(`/public/products/${product?.slug}`)
        .set('x-store-id', testStoreId!);

      expect(res.body.data.product.inStock).toBe(true);
    });

    it('should show out-of-stock for zero inventory', async () => {
      const outOfStockProduct = await prisma.product.create({
        data: {
          storeId: testStoreId!,
          name: 'Out of Stock Product',
          slug: `out-of-stock-${Date.now()}`,
          price: 1000,
          inventory: 0,
          status: 'active',
        },
      });

      const res = await request(app)
        .get(`/public/products/${outOfStockProduct.slug}`)
        .set('x-store-id', testStoreId!);

      expect(res.body.data.product.inStock).toBe(false);

      await prisma.product.delete({ where: { id: outOfStockProduct.id } });
    });
  });

  describe('Rate Limiting', () => {
    it('should apply rate limiting to public endpoints', async () => {
      const res = await request(app).get('/public/products').set('x-store-id', testStoreId!);

      expect(res.headers['ratelimit-policy']).toBeDefined();
    });
  });

  describe('Caching', () => {
    it('should include cache headers for static content', async () => {
      const res = await request(app).get(`/public/stores/${testStoreSlug}`);

      // Should have cache-related headers
      expect(res.headers['cache-control']).toBeDefined();
    });
  });
});
