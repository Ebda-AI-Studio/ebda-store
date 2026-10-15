/**
 * C-01 (P0, Qamar taste audit 2026-10-15) against real Postgres: a product
 * with variants is bought as one of its variants, never as the bare parent.
 *
 * Before the gate, a POST with no `variantId` on a sized product read the
 * parent's `inventory` column (0 by the inventory model): an in-stock product
 * was refused as "not enough inventory", and with the store's backorder
 * feature + the product's allowBackorder on it wrote a SIZELESS line that
 * checkout then sold. Both are asserted here, over HTTP through the
 * store-scoped cart mount (`tenantContext`, the ambient request transaction).
 *
 * The last case repeats the refusal over HTTP against the API running as
 * `ebda_app` (strict RLS + the tenant guard, as CI runs it) on the PUBLIC cart
 * route the storefront calls, so the variant-count read is proven admitted by
 * both layers, not only by the owner-role in-process client.
 *
 * Retry-safe: every test draws its own cart session from `cartSessionId()`,
 * and the store/products are keyed on a per-file random suffix that only
 * ever gets READ by the tests (nothing a retry could accumulate).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { withRlsBypass } from '@ebda/database';
import { errorHandler } from '@api/middleware/error-handler';
import { API_BASE } from '../helpers/api-base';
import {
  hasDb,
  buildBundleTestApp,
  seedBundleStore,
  seedProduct,
  cartClientFor,
  cartSessionId,
  type FixtureStore,
} from '../helpers/bundle-fixtures';

describe.skipIf(!hasDb)('cart refuses a variant product with no variant (VARIANT_REQUIRED)', () => {
  const suffix = `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  let app: Express;
  let store: FixtureStore;
  let sizedId: string; // has variants, parent inventory 0 (the model), allowBackorder ON
  let variantId: string;
  let plainId: string; // no variants

  const linesFor = async (sessionId: string) =>
    withRlsBypass(tx =>
      tx.cartItem.findMany({
        where: { cart: { storeId: store.storeId, sessionId } },
        select: { productId: true, variantId: true, quantity: true },
      })
    );

  beforeAll(async () => {
    app = buildBundleTestApp();
    app.use(errorHandler);
    store = await seedBundleStore(`varreq-${suffix}`);
    sizedId = await seedProduct(store.storeId, `${suffix}-abaya`, { price: 5000, inventory: 0 });
    plainId = await seedProduct(store.storeId, `${suffix}-scarf`, { price: 800, inventory: 20 });
    variantId = await withRlsBypass(async tx => {
      // Backorder ON at both gates, so the old code path would have WRITTEN the
      // sizeless line instead of refusing it.
      await tx.storeFeature.create({
        data: { storeId: store.storeId, featureKey: 'inventory.backorder', enabled: true },
      });
      await tx.product.update({ where: { id: sizedId }, data: { allowBackorder: true } });
      const v = await tx.productVariant.create({
        data: { productId: sizedId, title: 'M', titleAr: 'وسط', inventory: 7, price: 5000 },
      });
      return v.id;
    });
  });

  it('POST /cart/items with no variantId → 400 VARIANT_REQUIRED (ar + en), 0 rows, backorder on', async () => {
    const sessionId = cartSessionId('varreq-refused');
    const cart = cartClientFor(app, store.storeId, sessionId);

    const res = await cart.addToCart({ productId: sizedId, quantity: 1 });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VARIANT_REQUIRED');
    expect(res.body.error.details.messageEn).toMatch(/options/i);
    expect(res.body.error.details.messageAr).toMatch(/[؀-ۿ]/);
    expect(await linesFor(sessionId)).toEqual([]);
  });

  it('the same product WITH its variant is added as that variant', async () => {
    const sessionId = cartSessionId('varreq-variant');
    const cart = cartClientFor(app, store.storeId, sessionId);

    await cart.addToCart({ productId: sizedId, variantId, quantity: 1 }).expect(201);

    expect(await linesFor(sessionId)).toEqual([{ productId: sizedId, variantId, quantity: 1 }]);
  });

  it('a plain product still adds with no variantId', async () => {
    const sessionId = cartSessionId('varreq-plain');
    const cart = cartClientFor(app, store.storeId, sessionId);

    await cart.addToCart({ productId: plainId, quantity: 2 }).expect(201);

    expect(await linesFor(sessionId)).toEqual([
      { productId: plainId, variantId: null, quantity: 2 },
    ]);
  });

  it('POST /cart/sync drops the sizeless line and keeps the rest (Ruling FU46-W1a-2)', async () => {
    const sessionId = cartSessionId('varreq-sync');

    await request(app)
      .post(`/api/v1/stores/${store.storeId}/cart/sync`)
      .set('x-session-id', sessionId)
      .send({
        items: [
          { productId: sizedId, quantity: 1 },
          { productId: plainId, quantity: 1 },
        ],
      })
      .expect(200);

    expect(await linesFor(sessionId)).toEqual([
      { productId: plainId, variantId: null, quantity: 1 },
    ]);
  });

  it('over HTTP as ebda_app, public cart route: refused without a variant, accepted with one', async () => {
    const headers = {
      'Content-Type': 'application/json',
      'x-store-id': store.storeId,
      'x-session-id': cartSessionId('varreq-http'),
    };
    const bare = await fetch(`${API_BASE}/public/cart/items`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ productId: sizedId, quantity: 1 }),
    });
    const bareBody = (await bare.json()) as { error?: { code?: string } };
    expect(bare.status, JSON.stringify(bareBody)).toBe(400);
    expect(bareBody.error?.code).toBe('VARIANT_REQUIRED');

    const sized = await fetch(`${API_BASE}/public/cart/items`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ productId: sizedId, variantId, quantity: 1 }),
    });
    expect(sized.status, await sized.clone().text()).toBeLessThan(300);
    expect(await linesFor(headers['x-session-id'])).toEqual([
      { productId: sizedId, variantId, quantity: 1 },
    ]);
  });
});
