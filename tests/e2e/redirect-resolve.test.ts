/**
 * E2E for GET /public/redirects/resolve (Task 9).
 *
 * Minimal express app mounting only publicRoutes (no Redis / full boot),
 * mirroring tests/e2e/public-api.test.ts. Seeds SlugRedirect rows directly
 * via recordSlugRedirect (inside a transaction, matching how production
 * capture sites call it) rather than going through product/category/blog
 * write paths — this test targets the resolve endpoint only.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express from 'express';
import { prisma, SlugEntityType } from '@ebda/database';
import { recordSlugRedirect } from '../../apps/api/src/services/slug-redirect.service';
import publicRoutes from '@api/routes/public.routes';
import { errorHandler } from '@api/middleware/error-handler';

const app = express();
app.use(express.json());
app.use('/public', publicRoutes);
app.use(errorHandler);

let testStoreId: string | null = null;
let testUserId: string | null = null;

describe('GET /public/redirects/resolve', () => {
  beforeAll(async () => {
    const user = await prisma.user.create({
      data: {
        email: `redirect-resolve-test-${Date.now()}@example.com`,
        passwordHash: 'not-used-for-public-tests',
        firstName: 'Redirect',
        lastName: 'Tester',
        role: 'store_admin',
        emailVerified: true,
      },
    });
    testUserId = user.id;

    const store = await prisma.store.create({
      data: {
        name: 'Redirect Resolve Test Store',
        slug: `redirect-resolve-test-store-${Date.now()}`,
        ownerId: user.id,
        status: 'active',
        currency: 'EGP',
        template: 'qamar',
      },
    });
    testStoreId = store.id;

    await prisma.$transaction(async tx => {
      await recordSlugRedirect(tx, store.id, SlugEntityType.PRODUCT, 'old-prod', 'new-prod');
      await recordSlugRedirect(tx, store.id, SlugEntityType.CATEGORY, 'old-cat', 'new-cat');
      await recordSlugRedirect(tx, store.id, SlugEntityType.BLOG, 'old-post', 'new-post');
    });
  });

  afterAll(async () => {
    if (testStoreId) {
      await prisma.slugRedirect.deleteMany({ where: { storeId: testStoreId } });
      await prisma.store.delete({ where: { id: testStoreId } }).catch(() => {});
    }
    if (testUserId) {
      await prisma.user.delete({ where: { id: testUserId } }).catch(() => {});
    }
    await prisma.$disconnect();
  });

  it('resolves a renamed product slug', async () => {
    const res = await request(app)
      .get('/public/redirects/resolve')
      .query({ type: 'product', slug: 'old-prod' })
      .set('X-Store-ID', testStoreId!);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ toSlug: 'new-prod' });
  });

  it('resolves a renamed category slug', async () => {
    const res = await request(app)
      .get('/public/redirects/resolve')
      .query({ type: 'category', slug: 'old-cat' })
      .set('X-Store-ID', testStoreId!);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ toSlug: 'new-cat' });
  });

  it('resolves a renamed blog slug', async () => {
    const res = await request(app)
      .get('/public/redirects/resolve')
      .query({ type: 'blog', slug: 'old-post' })
      .set('X-Store-ID', testStoreId!);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ toSlug: 'new-post' });
  });

  // "No redirect" is an answer about a store that exists: 200 with a null `toSlug`. It was a 404, which the public
  // router's per-IP store-miss limiter counted, so one dead product link cost a shopper two misses.
  it('answers 200 with a null toSlug for a slug that was never redirected', async () => {
    const res = await request(app)
      .get('/public/redirects/resolve')
      .query({ type: 'product', slug: 'never-existed' })
      .set('X-Store-ID', testStoreId!);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ toSlug: null });
  });

  it('400s an invalid type', async () => {
    const res = await request(app)
      .get('/public/redirects/resolve')
      .query({ type: 'bogus', slug: 'x' })
      .set('X-Store-ID', testStoreId!);

    expect(res.status).toBe(400);
  });

  it('400s a missing slug', async () => {
    const res = await request(app)
      .get('/public/redirects/resolve')
      .query({ type: 'product' })
      .set('X-Store-ID', testStoreId!);

    expect(res.status).toBe(400);
  });
});
