/**
 * Public single-bundle detail route — GET /public/:storeId/bundles/:slug
 * (bundle.routes.ts) — the prerequisite the 2026-09-06 decisions ledger
 * flagged as missing before any `/bundles/<slug>` storefront page could
 * exist (T4 residual: "no public single-bundle detail route... bundle it
 * into that follow-up").
 *
 * Same gating/posture as the sibling list route (`GET
 * /public/:storeId/bundles`, covered by cart-bundles.test.ts indirectly via
 * `publicBundles()`), and the same conventions as that route's own tests:
 * real Postgres via `tests/helpers/bundle-fixtures.ts`, gated on `hasDb`.
 *
 * RULING C6: nothing here runs a Prisma migration command or points at a
 * hosted database — only the ordinary Prisma client against an
 * already-migrated local database.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import type { Express } from 'express';
import { prisma } from '@ebda/database';
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

describe.skipIf(!hasDb)('public bundle detail route', () => {
  const suffix = `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  let app: Express;
  let store: FixtureStore;
  let otherStore: FixtureStore;
  let noFeatureStore: FixtureStore;

  beforeAll(async () => {
    app = buildBundleTestApp();
    store = await seedBundleStore(suffix);
    otherStore = await seedBundleStore(`${suffix}-other`);
    noFeatureStore = await seedStoreWithoutBundlesFeature(`${suffix}-nofeature`);
  });

  it('returns a purchasable bundle with its component names, never pricingType/pricingValue/lines', async () => {
    const dates = await seedProduct(store.storeId, `${suffix}-dates`, {
      price: 500,
      inventory: 10,
    });
    const honey = await seedProduct(store.storeId, `${suffix}-honey`, {
      price: 300,
      inventory: 10,
    });
    const bundleId = await seedBundle(store.storeId, `${suffix}-ramadan`, {
      pricingType: 'fixed_price',
      pricingValue: 700,
      items: [
        { productId: dates, quantity: 1 },
        { productId: honey, quantity: 1 },
      ],
    });
    const slug = await slugOf(store.storeId, bundleId);

    const client = cartClientFor(app, store.storeId, `${suffix}-sess-1`);
    const res = await client.publicBundleDetail(slug);

    expect(res.status).toBe(200);
    const bundle = res.body.data.bundle;
    expect(bundle).toMatchObject({
      id: bundleId,
      slug,
      price: 700,
      componentSum: 800,
      available: 10,
      isPurchasable: true,
    });
    expect(bundle.componentNames).toHaveLength(2);
    expect(bundle.componentNames.map((c: { name: string }) => c.name).sort()).toEqual(
      [`bundle-fixture-product-${suffix}-dates`, `bundle-fixture-product-${suffix}-honey`].sort()
    );

    // The whole point of this feature: never leak the internal allocation.
    expect(bundle).not.toHaveProperty('pricingType');
    expect(bundle).not.toHaveProperty('pricingValue');
    expect(bundle).not.toHaveProperty('lines');
    expect(JSON.stringify(bundle)).not.toMatch(/unitPrice/);
  });

  it('404s a bundle belonging to ANOTHER store (tenant isolation, never leaks cross-store existence)', async () => {
    const product = await seedProduct(otherStore.storeId, `${suffix}-other-p`, {
      price: 400,
      inventory: 5,
    });
    const bundleId = await seedBundle(otherStore.storeId, `${suffix}-other-bundle`, {
      pricingType: 'fixed_price',
      pricingValue: 350,
      items: [{ productId: product, quantity: 1 }],
    });
    const slug = await slugOf(otherStore.storeId, bundleId);

    // Ask STORE A's route for a slug that only exists on STORE B.
    const client = cartClientFor(app, store.storeId, `${suffix}-sess-2`);
    const res = await client.publicBundleDetail(slug);

    expect(res.status).toBe(404);
  });

  it('404s a bundle the merchant deactivated (isActive: false) — mirrors an unpublished product, not "shown as unavailable"', async () => {
    const product = await seedProduct(store.storeId, `${suffix}-inactive-p`, {
      price: 400,
      inventory: 5,
    });
    const bundleId = await seedBundle(store.storeId, `${suffix}-inactive-bundle`, {
      pricingType: 'fixed_price',
      pricingValue: 350,
      items: [{ productId: product, quantity: 1 }],
      isActive: false,
    });
    const slug = await slugOf(store.storeId, bundleId);

    const client = cartClientFor(app, store.storeId, `${suffix}-sess-3`);
    const res = await client.publicBundleDetail(slug);

    expect(res.status).toBe(404);
  });

  it('resolves (200) a bundle that is out of stock, with isPurchasable:false — mirrors an out-of-stock PRODUCT still 200ing', async () => {
    const product = await seedProduct(store.storeId, `${suffix}-oos-p`, {
      price: 400,
      inventory: 1,
    });
    const bundleId = await seedBundle(store.storeId, `${suffix}-oos-bundle`, {
      pricingType: 'fixed_price',
      pricingValue: 350,
      items: [{ productId: product, quantity: 1 }],
    });
    await setStock(product, 0);
    const slug = await slugOf(store.storeId, bundleId);

    const client = cartClientFor(app, store.storeId, `${suffix}-sess-4`);
    const res = await client.publicBundleDetail(slug);

    expect(res.status).toBe(200);
    expect(res.body.data.bundle.isPurchasable).toBe(false);
    expect(res.body.data.bundle.available).toBe(0);
  });

  it('a store without the bundles feature gets nothing from the route, even for a bundle that exists in its DB', async () => {
    const product = await seedProduct(noFeatureStore.storeId, `${suffix}-nf-p`, {
      price: 400,
      inventory: 5,
    });
    const bundleId = await seedBundle(noFeatureStore.storeId, `${suffix}-nf-bundle`, {
      pricingType: 'fixed_price',
      pricingValue: 350,
      items: [{ productId: product, quantity: 1 }],
    });
    const slug = await slugOf(noFeatureStore.storeId, bundleId);

    const client = cartClientFor(app, noFeatureStore.storeId, `${suffix}-sess-5`);
    const res = await client.publicBundleDetail(slug);

    // requireFeature fails closed with 403 FEATURE_DISABLED — never a body
    // that reveals the bundle exists.
    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).not.toContain(bundleId);
  });

  it('404s an unknown slug for a real, feature-enabled store', async () => {
    const client = cartClientFor(app, store.storeId, `${suffix}-sess-6`);
    const res = await client.publicBundleDetail('this-slug-does-not-exist');
    expect(res.status).toBe(404);
  });
});

// Bundles are seeded with a random-suffixed slug (see `seedBundle`'s doc
// comment) — look it up rather than hardcoding it.
async function slugOf(storeId: string, bundleId: string): Promise<string> {
  const row = await prisma.bundle.findFirstOrThrow({
    where: { id: bundleId, storeId },
    select: { slug: true },
  });
  return row.slug;
}
