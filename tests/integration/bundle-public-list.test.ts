/**
 * Public bundle LIST route — GET /public/:storeId/bundles (bundle.routes.ts)
 * — backs the `/bundles` storefront index page (product-bundles gap 1).
 *
 * Cross-tenant isolation for this route is already covered by
 * cart-bundles.test.ts ("store B's bundle never appears in store A's
 * public bundle list"). This file covers the two properties that page's
 * "no page-builder UI without a real customer path" bar needs and that
 * were not yet under test: the list is pre-filtered to `isPurchasable`
 * bundles ONLY (a merchant must never see a sold-out/inactive/not-yet-
 * started bundle offered on the storefront), and a store without the
 * `bundles` feature gets nothing from it at all — same 403-means-"no
 * page" posture `BundlesPageBody` (apps/web) relies on.
 *
 * Real Postgres via tests/helpers/bundle-fixtures.ts, gated on `hasDb`.
 * RULING C6: nothing here runs a Prisma migration command or points at a
 * hosted database — only the ordinary Prisma client against an
 * already-migrated local database.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import type { Express } from 'express';
import { invalidateStoreProductCaches } from '../../apps/api/src/lib/public-cache';
import {
  hasDb,
  buildBundleTestApp,
  seedBundleStore,
  seedStoreWithoutBundlesFeature,
  seedProduct,
  seedBundle,
  setStock,
  cartClientFor,
  type FixtureStore,
} from '../helpers/bundle-fixtures';

describe.skipIf(!hasDb)('public bundle list route', () => {
  const suffix = `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  let app: Express;
  let store: FixtureStore;
  let noFeatureStore: FixtureStore;

  beforeAll(async () => {
    app = buildBundleTestApp();
    store = await seedBundleStore(suffix);
    noFeatureStore = await seedStoreWithoutBundlesFeature(`${suffix}-nofeature`);
  });

  it('lists only isPurchasable bundles — an out-of-stock bundle is silently excluded, not shown as unavailable', async () => {
    const inStockProduct = await seedProduct(store.storeId, `${suffix}-instock`, {
      price: 500,
      inventory: 10,
    });
    const purchasableBundleId = await seedBundle(store.storeId, `${suffix}-purchasable`, {
      name: `Purchasable Bundle ${suffix}`,
      pricingType: 'fixed_price',
      pricingValue: 400,
      items: [{ productId: inStockProduct, quantity: 1 }],
    });

    const outOfStockProduct = await seedProduct(store.storeId, `${suffix}-oos`, {
      price: 500,
      inventory: 10,
    });
    const outOfStockBundleId = await seedBundle(store.storeId, `${suffix}-oos-bundle`, {
      name: `Out Of Stock Bundle ${suffix}`,
      pricingType: 'fixed_price',
      pricingValue: 400,
      items: [{ productId: outOfStockProduct, quantity: 1 }],
    });
    await setStock(outOfStockProduct, 0);

    // #1565 gave this route a 120s cache under `public:products:${storeId}:`.
    // The fixtures above write directly via Prisma (`withRlsBypass`), bypassing
    // every admin route that would normally bust it on a real write — bust it
    // ourselves so this test observes what it just seeded, not a prior test's
    // cached list for the SAME store.
    await invalidateStoreProductCaches(store.storeId);
    const cart = cartClientFor(app, store.storeId, `session-${suffix}-list`);
    const res = await cart.publicBundles().expect(200);
    const ids = res.body.data.bundles.map((b: { id: string }) => b.id);

    expect(ids).toContain(purchasableBundleId);
    expect(ids).not.toContain(outOfStockBundleId);
  });

  it('never exposes pricingType/pricingValue/componentSum-as-price on a listed bundle', async () => {
    const productId = await seedProduct(store.storeId, `${suffix}-shape`, {
      price: 600,
      inventory: 10,
    });
    const bundleId = await seedBundle(store.storeId, `${suffix}-shape-bundle`, {
      name: `Shape Bundle ${suffix}`,
      pricingType: 'fixed_price',
      pricingValue: 500,
      items: [{ productId, quantity: 1 }],
    });

    await invalidateStoreProductCaches(store.storeId); // see the list test's comment above
    const cart = cartClientFor(app, store.storeId, `session-${suffix}-shape`);
    const res = await cart.publicBundles().expect(200);
    const bundle = res.body.data.bundles.find((b: { id: string }) => b.id === bundleId);

    expect(bundle).toBeDefined();
    expect(bundle.price).toBe(500);
    expect(bundle.componentSum).toBe(600);
    expect(bundle).not.toHaveProperty('pricingType');
    expect(bundle).not.toHaveProperty('pricingValue');
    expect(bundle).not.toHaveProperty('lines');
  });

  it('a store without the bundles feature gets 403 (FEATURE_DISABLED), not an empty 200 — "no page" for /bundles depends on this distinction', async () => {
    const cart = cartClientFor(app, noFeatureStore.storeId, `session-${suffix}-nofeature`);
    const res = await cart.publicBundles();
    expect(res.status).toBe(403);
  });

  it('#1565 — the route is actually CACHED: a direct DB deactivation is not reflected until the cache is busted', async () => {
    // A per-CALL unique suffix, not the shared per-file `suffix` — this test
    // seeds its own store inline in the test body (not `beforeAll`), and
    // `vitest.config.ts`'s `retry: 1` re-runs a failed test body against the
    // same database: a fixture keyed on the shared per-file suffix would trip
    // a unique-email violation on retry instead of showing the real failure.
    const callSuffix = `${suffix}-cache-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const cacheStore = await seedBundleStore(callSuffix);
    const product = await seedProduct(cacheStore.storeId, `${callSuffix}-p`, {
      price: 200,
      inventory: 10,
    });
    const bundleId = await seedBundle(cacheStore.storeId, `${callSuffix}-bundle`, {
      name: `Cache Bundle ${callSuffix}`,
      pricingType: 'fixed_price',
      pricingValue: 150,
      items: [{ productId: product, quantity: 1 }],
    });
    const cart = cartClientFor(app, cacheStore.storeId, `session-${callSuffix}`);

    // First call: cache miss, populates the cache with the bundle present.
    const first = await cart.publicBundles().expect(200);
    expect(first.body.data.bundles.map((b: { id: string }) => b.id)).toContain(bundleId);

    // Deactivate DIRECTLY via Prisma — bypassing every admin route that would
    // normally bust the cache — and call again with NO invalidation. If the
    // route were still uncached (the pre-#1565 shape), this would already
    // reflect the deactivation; the whole point of caching this route is that
    // it does NOT, for up to the TTL.
    const { prisma } = await import('@force/database');
    await prisma.bundle.update({ where: { id: bundleId }, data: { isActive: false } });
    const second = await cart.publicBundles().expect(200);
    expect(second.body.data.bundles.map((b: { id: string }) => b.id)).toContain(bundleId);

    // Now bust it — the same call every real bundle write already makes —
    // and confirm the deactivation is now visible.
    await invalidateStoreProductCaches(cacheStore.storeId);
    const third = await cart.publicBundles().expect(200);
    expect(third.body.data.bundles.map((b: { id: string }) => b.id)).not.toContain(bundleId);
  });
});
