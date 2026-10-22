/**
 * Phase B3 Task 3 (Ruling B3-6) against real Postgres: the data behind the two PDP lines.
 *
 * Rating (BOUNDED-stale): `ratingStats` counts only PUBLISHED verified reviews; moderating a
 * review through the real admin route purges the product caches, and the next read sees the new
 * aggregate.
 *
 * Bundle saving (NEVER-stale for price): `GET /stores/public/:storeId/bundle-savings` is computed
 * from `resolveBundle` on every request (answered `no-store`), so a bundle price edit through the
 * real admin route changes the percentage on the very next call. Tenant-isolated, feature-gated,
 * and an inactive / sold-out / expired bundle never advertises a saving.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';
import { withRlsBypass } from '@ebda/database';
import {
  hasDb,
  buildBundleTestApp,
  seedBundleStore,
  seedStoreWithoutBundlesFeature,
  seedProduct,
  seedBundle,
  setStock,
  adminBundleClientFor,
  storeAdminAccessTokenFor,
  type FixtureStore,
} from '../helpers/bundle-fixtures';

const purged: string[] = [];
vi.mock('../../apps/api/src/lib/public-cache', async importOriginal => {
  const real = await importOriginal<Record<string, unknown>>();
  return {
    ...real,
    invalidateStoreProductCaches: vi.fn(async (storeId: string) => {
      purged.push(storeId);
      return (real.invalidateStoreProductCaches as (s: string) => Promise<void>)(storeId);
    }),
  };
});

const { ProductService } = await import('../../apps/api/src/services/product.service');
const { default: reviewRoutes } = await import('../../apps/api/src/routes/review.routes');
const { tenantContext } = await import('../../apps/api/src/middleware/tenant-context');

const suffix = `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
const savingsUrl = (storeId: string, ids: string[]) =>
  `/api/v1/stores/public/${storeId}/bundle-savings?productIds=${ids.join(',')}`;

describe.skipIf(!hasDb)('PDP bundle saving (live, never cached)', () => {
  let app: Express;
  let store: FixtureStore;
  let other: FixtureStore;
  let noFeature: FixtureStore;
  let a: string;
  let b: string;
  let bundleId: string;

  beforeAll(async () => {
    app = buildBundleTestApp();
    store = await seedBundleStore(`${suffix}-s`);
    other = await seedBundleStore(`${suffix}-o`);
    noFeature = await seedStoreWithoutBundlesFeature(`${suffix}-nf`);
    a = await seedProduct(store.storeId, `${suffix}-a`, { price: 5000, inventory: 10 });
    b = await seedProduct(store.storeId, `${suffix}-b`, { price: 5000, inventory: 10 });
    // 8500 for two 5000 pieces: a real 15% saving.
    bundleId = await seedBundle(store.storeId, `${suffix}-routine`, {
      pricingType: 'fixed_price',
      pricingValue: 8500,
      items: [
        { productId: a, quantity: 1 },
        { productId: b, quantity: 1 },
      ],
    });
  });

  it('a product in the bundle gets the real saving, computed from the cart bundle price', async () => {
    const res = await request(app)
      .get(savingsUrl(store.storeId, [a]))
      .expect(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const [s] = res.body.data.savings;
    expect(s).toMatchObject({
      bundleId,
      price: 8500,
      componentSum: 10000,
      saving: 1500,
      percent: 15,
      exact: false,
    });
  });

  it('the whole set is an exact match (so "add all" can add the bundle itself); a subset is not', async () => {
    const both = await request(app)
      .get(savingsUrl(store.storeId, [a, b]))
      .expect(200);
    expect(both.body.data.savings[0]).toMatchObject({ bundleId, exact: true });
    const one = await request(app)
      .get(savingsUrl(store.storeId, [b]))
      .expect(200);
    expect(one.body.data.savings[0].exact).toBe(false);
  });

  it('NEVER-stale pin: a bundle price edit through the admin route changes the line on the next call', async () => {
    const before = await request(app)
      .get(savingsUrl(store.storeId, [a]))
      .expect(200);
    expect(before.body.data.savings[0].percent).toBe(15);
    const admin = adminBundleClientFor(app, store);
    await admin
      .update(bundleId, {
        pricingType: 'fixed_price',
        pricingValue: 8000,
        items: [
          { productId: a, quantity: 1 },
          { productId: b, quantity: 1 },
        ],
      })
      .expect(200);
    const after = await request(app)
      .get(savingsUrl(store.storeId, [a]))
      .expect(200);
    expect(after.body.data.savings[0]).toMatchObject({ price: 8000, saving: 2000, percent: 20 });
  });

  it('negative controls: no bundle for a product, another store, no feature, bad ids', async () => {
    const lone = await seedProduct(store.storeId, `${suffix}-lone`, { price: 3000, inventory: 5 });
    expect(
      (
        await request(app)
          .get(savingsUrl(store.storeId, [lone]))
          .expect(200)
      ).body.data.savings
    ).toEqual([]);
    // store A's product ids asked of store B (tenant isolation)
    expect(
      (
        await request(app)
          .get(savingsUrl(other.storeId, [a, b]))
          .expect(200)
      ).body.data.savings
    ).toEqual([]);
    // a store without the bundles feature is a 403, never an empty 200
    expect((await request(app).get(savingsUrl(noFeature.storeId, [a]))).status).toBe(403);
    // malformed / missing / too many ids are a 4xx, not a query
    expect(
      (await request(app).get(`/api/v1/stores/public/${store.storeId}/bundle-savings`)).status
    ).toBeGreaterThanOrEqual(400);
    expect(
      (await request(app).get(savingsUrl(store.storeId, ['not-a-uuid']))).status
    ).toBeGreaterThanOrEqual(400);
    const six = Array.from({ length: 6 }, () => '00000000-0000-4000-8000-000000000001');
    expect((await request(app).get(savingsUrl(store.storeId, six))).status).toBeGreaterThanOrEqual(
      400
    );
  });

  it('a sold-out, inactive or expired bundle never advertises a saving', async () => {
    const c = await seedProduct(store.storeId, `${suffix}-c`, { price: 4000, inventory: 10 });
    const d = await seedProduct(store.storeId, `${suffix}-d`, { price: 4000, inventory: 10 });
    const sold = await seedBundle(store.storeId, `${suffix}-sold`, {
      pricingType: 'fixed_price',
      pricingValue: 7000,
      items: [
        { productId: c, quantity: 1 },
        { productId: d, quantity: 1 },
      ],
    });
    expect(
      (
        await request(app)
          .get(savingsUrl(store.storeId, [c]))
          .expect(200)
      ).body.data.savings
    ).toHaveLength(1);
    await setStock(d, 0);
    expect(
      (
        await request(app)
          .get(savingsUrl(store.storeId, [c]))
          .expect(200)
      ).body.data.savings
    ).toEqual([]);
    await setStock(d, 10);
    await withRlsBypass(tx => tx.bundle.update({ where: { id: sold }, data: { isActive: false } }));
    expect(
      (
        await request(app)
          .get(savingsUrl(store.storeId, [c]))
          .expect(200)
      ).body.data.savings
    ).toEqual([]);
    await withRlsBypass(tx =>
      tx.bundle.update({
        where: { id: sold },
        data: { isActive: true, expiresAt: new Date(Date.now() - 60_000) },
      })
    );
    expect(
      (
        await request(app)
          .get(savingsUrl(store.storeId, [c]))
          .expect(200)
      ).body.data.savings
    ).toEqual([]);
  });
});

describe.skipIf(!hasDb)('PDP rating line data (bounded-stale, moderation purges)', () => {
  let store: FixtureStore;
  let productId: string;
  let slug: string;
  let reviewIds: string[] = [];
  let app: Express;

  async function mkReview(rating: number, status: string, verified = true) {
    const order = await withRlsBypass(async tx => {
      const addr = { firstName: 'A', lastName: 'B', city: 'Cairo', country: 'EG', address1: 'x' };
      return tx.order.create({
        data: {
          storeId: store.storeId,
          orderNumber: `RT-${Math.random().toString(36).slice(2, 10)}`,
          subtotal: 100,
          total: 100,
          status: 'delivered' as never,
          shippingAddress: addr,
          billingAddress: addr,
        },
      });
    });
    const r = await withRlsBypass(tx =>
      tx.review.create({
        data: {
          storeId: store.storeId,
          productId,
          orderId: order.id,
          rating,
          body: 'a review body that is long enough to be a review',
          status,
          verifiedPurchase: verified,
        },
      })
    );
    reviewIds.push(r.id);
    return r.id;
  }

  beforeAll(async () => {
    store = await seedBundleStore(`${suffix}-rating`);
    await withRlsBypass(tx =>
      tx.storeFeature.create({
        data: { storeId: store.storeId, featureKey: 'reviews', enabled: true },
      })
    );
    productId = await seedProduct(store.storeId, `${suffix}-rated`, { price: 5000, inventory: 5 });
    slug = (await withRlsBypass(tx => tx.product.findUniqueOrThrow({ where: { id: productId } })))
      .slug;
    app = express();
    app.use(express.json());
    app.use('/api/v1/stores/:storeId/reviews', tenantContext, reviewRoutes);
    await mkReview(5, 'published');
    await mkReview(4, 'published');
    await mkReview(1, 'pending');
    await mkReview(1, 'rejected');
    await mkReview(2, 'published', false); // not a verified purchase: never counted
  });

  it('ratingStats averages only published verified reviews', async () => {
    const p = await ProductService.getPublicBySlug(store.storeId, slug);
    expect(p.ratingStats).toEqual({ ratingAverage: 4.5, ratingCount: 2 });
  });

  it('a product with no review has count 0 and a null average (so the line renders nothing)', async () => {
    const bare = await seedProduct(store.storeId, `${suffix}-bare`, { price: 1000, inventory: 5 });
    const bareSlug = (
      await withRlsBypass(tx => tx.product.findUniqueOrThrow({ where: { id: bare } }))
    ).slug;
    const p = await ProductService.getPublicBySlug(store.storeId, bareSlug);
    expect(p.ratingStats).toEqual({ ratingAverage: null, ratingCount: 0 });
  });

  it('approving a pending review through the admin route purges the product caches and reaches the aggregate', async () => {
    const pending = reviewIds[2];
    const token = storeAdminAccessTokenFor(store.ownerId);
    const before = purged.length;
    await request(app)
      .post(`/api/v1/stores/${store.storeId}/reviews/admin/${pending}/approve`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(purged.slice(before)).toContain(store.storeId);
    const p = await ProductService.getPublicBySlug(store.storeId, slug);
    expect(p.ratingStats.ratingCount).toBe(3);
    expect(p.ratingStats.ratingAverage).toBe(3.3); // (5 + 4 + 1) / 3
  });

  it('rejecting a published review purges again and lowers the count', async () => {
    const token = storeAdminAccessTokenFor(store.ownerId);
    const before = purged.length;
    await request(app)
      .post(`/api/v1/stores/${store.storeId}/reviews/admin/${reviewIds[2]}/reject`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(purged.length).toBeGreaterThan(before);
    const p = await ProductService.getPublicBySlug(store.storeId, slug);
    expect(p.ratingStats).toEqual({ ratingAverage: 4.5, ratingCount: 2 });
  });
});
