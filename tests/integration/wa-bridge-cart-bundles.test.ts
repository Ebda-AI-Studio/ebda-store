/**
 * `POST /wa-bridge/cart/from-wa` accepts bundle ids (Task 10 — closes the
 * WhatsApp-ordering bundle gap).
 *
 * `/store-catalog` already advertises bundles to WBS as catalogue entries
 * (siblings of a product, `isBundle: true`) whenever the store's `bundles`
 * feature is on. WBS echoes back whatever id it was given — so before this
 * change, picking a bundle in the WhatsApp bot produced `PRODUCTS_NOT_FOUND`
 * (the id never matched a `Product` row). This suite is the regression test
 * for the fix: an id that fails to resolve as a product is tried as a
 * bundle via `resolveBundle` — but ONLY when the store's `bundles` feature
 * is enabled, so a store without the flag sees byte-identical behaviour
 * (RULING: `bundles` is in no plan baseline — off for every store unless a
 * super-admin override exists).
 *
 * Real Postgres throughout (same convention as `cart-bundles.test.ts`) —
 * gated on `hasDb`. The bridge's own API-key lookup (`wa-bridge-auth.ts`)
 * is mocked to inject `req.bridgeStore` directly for whichever store a
 * test is exercising — this suite is about the ROUTE's bundle-resolution
 * logic, not the bridge auth middleware (covered elsewhere).
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import type { Express } from 'express';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { config } from '@api/config';
import {
  hasDb,
  seedBundleStore,
  seedStoreWithoutBundlesFeature,
  seedProduct,
  seedBundle,
  setStock,
  type FixtureStore,
} from '../helpers/bundle-fixtures';

// Hoisted mutable holder so the mocked middleware can pick up whichever
// store the CURRENT test wants authenticated, without re-mocking per test.
const bridgeAuthState = vi.hoisted(() => ({
  store: undefined as
    | { id: string; slug: string; name: string; currency: string; wbsClientId: string | null }
    | undefined,
}));

vi.mock('@api/middleware/wa-bridge-auth', () => ({
  waBridgeAuth: (req: any, res: any, next: any) => {
    if (!bridgeAuthState.store) {
      res.status(401).json({ success: false, error: 'WBS_API_KEY_INVALID' });
      return;
    }
    req.bridgeStore = bridgeAuthState.store;
    next();
  },
}));

// Imported AFTER the mock so the router picks up the mocked middleware.
import waBridgeRoutes from '@api/routes/wa-bridge.routes';

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/wa-bridge', waBridgeRoutes);
  return app;
}

function authAs(store: FixtureStore, overrides: Partial<{ slug: string; currency: string }> = {}) {
  bridgeAuthState.store = {
    id: store.storeId,
    slug: overrides.slug ?? 'test-store',
    name: 'Test Store',
    currency: overrides.currency ?? 'EGP',
    wbsClientId: 'wbs-client-test',
  };
}

function decodeToken(token: string): Record<string, unknown> {
  return jwt.verify(token, config.jwtSecret, {
    algorithms: ['HS256'],
    issuer: 'force-api',
    audience: 'force-wa-cart',
  }) as Record<string, unknown>;
}

describe.skipIf(!hasDb)('POST /wa-bridge/cart/from-wa — bundle ids', () => {
  const suffix = `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  let app: Express;

  beforeAll(() => {
    app = buildApp();
  });

  it('flag OFF: a bundle id is rejected exactly like an unknown id — PRODUCTS_NOT_FOUND, response byte-identical to the pre-bundle shape', async () => {
    // The bundle is real AND owned by the SAME store making the request —
    // this isolates the feature-flag guard specifically. (A bundle owned
    // by a different store would 404 on tenant-scope alone regardless of
    // the flag, which wouldn't prove the flag check does anything.)
    const noFeatureStore = await seedStoreWithoutBundlesFeature(`${suffix}-flagoff-caller`);
    const bp = await seedProduct(noFeatureStore.storeId, `${suffix}-flagoff-bp`, {
      price: 500,
      inventory: 10,
    });
    const bundleId = await seedBundle(noFeatureStore.storeId, `${suffix}-flagoff`, {
      pricingType: 'fixed_price',
      pricingValue: 400,
      items: [{ productId: bp, quantity: 1 }],
    });

    authAs(noFeatureStore);

    const res = await request(app)
      .post('/api/v1/wa-bridge/cart/from-wa')
      .set('X-WBS-API-KEY', 'irrelevant-mocked')
      .send({ items: [{ productId: bundleId, quantity: 1 }], customerPhone: '96550000001' });

    expect(res.status).toBe(400);
    // Byte-identical to the pre-bundle PRODUCTS_NOT_FOUND shape — no new
    // key, no bundle-specific message, same `missing` array shape.
    expect(res.body).toEqual({
      success: false,
      error: 'PRODUCTS_NOT_FOUND',
      missing: [bundleId],
    });
  });

  it('flag ON: a bundle id resolves — 200, token carries the bundle, totalFils is the bundle price x quantity, NOT the component sum', async () => {
    const store = await seedBundleStore(`${suffix}-flagon-total`);
    const p1 = await seedProduct(store.storeId, `${suffix}-p1`, { price: 500, inventory: 10 });
    const p2 = await seedProduct(store.storeId, `${suffix}-p2`, { price: 300, inventory: 10 });
    // componentSum = 800; bundle sells at a fixed 700 — must never be
    // charged as 800 (component sum) nor as 800*quantity.
    const bundleId = await seedBundle(store.storeId, `${suffix}-flagon`, {
      pricingType: 'fixed_price',
      pricingValue: 700,
      items: [
        { productId: p1, quantity: 1 },
        { productId: p2, quantity: 1 },
      ],
    });

    authAs(store);
    const res = await request(app)
      .post('/api/v1/wa-bridge/cart/from-wa')
      .set('X-WBS-API-KEY', 'irrelevant-mocked')
      .send({ items: [{ productId: bundleId, quantity: 2 }], customerPhone: '96550000002' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.summary.totalFils).toBe(1400); // 700 * 2, never 800 * 2 (1600)
    expect(res.body.data.summary.itemCount).toBe(2);

    const payload = decodeToken(res.body.data.checkoutToken);
    expect(payload.totalFils).toBe(1400);
    expect(payload.items).toEqual([]);
    expect(payload.bundles).toEqual([
      { bundleId, quantity: 2, priceFils: 700, name: expect.any(String), nameAr: null },
    ]);
  });

  it('flag ON: a mixed payload (one product + one bundle) — both present, total is the sum of both', async () => {
    const store = await seedBundleStore(`${suffix}-mixed`);
    const looseProduct = await seedProduct(store.storeId, `${suffix}-loose`, {
      price: 250,
      inventory: 10,
    });
    const c1 = await seedProduct(store.storeId, `${suffix}-mixed-c1`, {
      price: 400,
      inventory: 10,
    });
    const bundleId = await seedBundle(store.storeId, `${suffix}-mixed-bundle`, {
      pricingType: 'fixed_price',
      pricingValue: 350,
      items: [{ productId: c1, quantity: 1 }],
    });

    authAs(store);
    const res = await request(app)
      .post('/api/v1/wa-bridge/cart/from-wa')
      .set('X-WBS-API-KEY', 'irrelevant-mocked')
      .send({
        items: [
          { productId: looseProduct, quantity: 1 },
          { productId: bundleId, quantity: 1 },
        ],
        customerPhone: '96550000003',
      });

    expect(res.status).toBe(200);
    expect(res.body.data.summary.totalFils).toBe(600); // 250 + 350
    expect(res.body.data.summary.itemCount).toBe(2);

    const payload = decodeToken(res.body.data.checkoutToken);
    expect(payload.items).toEqual([
      {
        productId: looseProduct,
        quantity: 1,
        priceFils: 250,
        name: expect.any(String),
        nameAr: null,
      },
    ]);
    expect(payload.bundles).toEqual([
      { bundleId, quantity: 1, priceFils: 350, name: expect.any(String), nameAr: null },
    ]);
  });

  it('flag ON: a bundle whose component stock cannot cover the requested quantity — 409 INSUFFICIENT_INVENTORY, naming the bundle', async () => {
    const store = await seedBundleStore(`${suffix}-oos`);
    const scarce = await seedProduct(store.storeId, `${suffix}-scarce`, {
      price: 500,
      inventory: 10,
    });
    const bundleId = await seedBundle(store.storeId, `${suffix}-oos-bundle`, {
      pricingType: 'fixed_price',
      pricingValue: 450,
      items: [{ productId: scarce, quantity: 2 }], // needs 2 units of `scarce` per bundle
    });
    await setStock(scarce, 1); // only 1 in stock -> floor(1/2) = 0 bundles makeable

    authAs(store);
    const res = await request(app)
      .post('/api/v1/wa-bridge/cart/from-wa')
      .set('X-WBS-API-KEY', 'irrelevant-mocked')
      .send({ items: [{ productId: bundleId, quantity: 1 }], customerPhone: '96550000004' });

    expect(res.status).toBe(409);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe('INSUFFICIENT_INVENTORY');
    expect(res.body.outOfStock).toEqual([
      { productId: bundleId, requested: 1, available: 0, name: expect.any(String) },
    ]);
  });

  it("cross-tenant: a bundle belonging to store B is never resolved against store A's bridge key — PRODUCTS_NOT_FOUND, not leaked", async () => {
    const storeA = await seedBundleStore(`${suffix}-tenant-a`);
    const storeB = await seedBundleStore(`${suffix}-tenant-b`);
    const bp = await seedProduct(storeB.storeId, `${suffix}-tenant-b-p`, {
      price: 500,
      inventory: 10,
    });
    const storeBBundleId = await seedBundle(storeB.storeId, `${suffix}-tenant-b-bundle`, {
      pricingType: 'fixed_price',
      pricingValue: 400,
      items: [{ productId: bp, quantity: 1 }],
    });

    // Authenticated as store A (its own bridge key) but sending store B's
    // bundle id — resolveBundle's tenant-resolver rule (filter by storeId,
    // throw rather than default) must refuse this exactly like an unknown
    // id, never resolving another tenant's bundle.
    authAs(storeA);
    const res = await request(app)
      .post('/api/v1/wa-bridge/cart/from-wa')
      .set('X-WBS-API-KEY', 'irrelevant-mocked')
      .send({ items: [{ productId: storeBBundleId, quantity: 1 }], customerPhone: '96550000005' });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      success: false,
      error: 'PRODUCTS_NOT_FOUND',
      missing: [storeBBundleId],
    });
  });
});
