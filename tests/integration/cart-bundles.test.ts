/**
 * Cart holds bundles — never expanded into cart_items (Task 5, product bundles).
 *
 * The regression this file exists to prevent: `cart_items` carries two
 * PARTIAL UNIQUE INDEXES — `(cart_id, product_id)` WHERE `variant_id IS
 * NULL`, and `(cart_id, product_id, variant_id)` WHERE `variant_id IS NOT
 * NULL`. If a bundle were expanded into `cart_items` rows, a customer who
 * already had one of the bundle's own products in their cart would hit
 * that index the moment they added the bundle, and the request would 500 on
 * a live store. `CartBundle` is a separate table for exactly this reason —
 * "a bundle containing a product already in the cart" below is the direct
 * regression test for it.
 *
 * Real Postgres throughout (RULING T3-c) — no mocked Prisma client. Gated
 * on `hasDb` (see tests/helpers/bundle-fixtures.ts) so this suite skips
 * cleanly wherever no real database is configured, same as every other
 * real-DB suite under tests/integration.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import type { Express } from 'express';
import {
  hasDb,
  buildBundleTestApp,
  seedBundleStore,
  seedProduct,
  seedBundle,
  seedCustomer,
  setStock,
  resolveBundleFor,
  cartClientFor,
  cartSessionId,
  type FixtureStore,
} from '../helpers/bundle-fixtures';
import { prisma } from '@force/database';
import { CartService } from '@api/services/cart.service';

describe.skipIf(!hasDb)('cart holds bundles', () => {
  const suffix = `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  let app: Express;
  let store: FixtureStore;

  beforeAll(async () => {
    app = buildBundleTestApp();
    store = await seedBundleStore(suffix);
  });

  it('accepts a bundle containing a product already in the cart', async () => {
    const dates = await seedProduct(store.storeId, `${suffix}-dates`, {
      price: 500,
      inventory: 10,
    });
    const honey = await seedProduct(store.storeId, `${suffix}-honey`, {
      price: 300,
      inventory: 10,
    });
    const ramadanBox = await seedBundle(store.storeId, `${suffix}-ramadan`, {
      pricingType: 'fixed_price',
      pricingValue: 700,
      items: [
        { productId: dates, quantity: 1 },
        { productId: honey, quantity: 1 },
      ],
    });

    const sessionId = cartSessionId('already-in-cart');
    const cart = cartClientFor(app, store.storeId, sessionId);

    await cart.addToCart({ productId: dates, quantity: 1 }).expect(201);

    // The regression: if the bundle expanded into cart_items, this second
    // write would collide with the partial unique index on
    // (cart_id, product_id) WHERE variant_id IS NULL and 500.
    const res = await cart.addBundleToCart({ bundleId: ramadanBox, quantity: 1 });
    expect(res.status).toBe(201);

    const got = await cart.getCart().expect(200);
    expect(got.body.data.cart.items).toHaveLength(1); // the standalone dates, untouched
    expect(got.body.data.cart.bundles).toHaveLength(1); // the box, in its own row
    expect(got.body.data.cart.items[0].quantity).toBe(1);
  });

  it('refuses a quantity the component stock cannot make', async () => {
    const dates = await seedProduct(store.storeId, `${suffix}-dates2`, {
      price: 500,
      inventory: 10,
    });
    const honey = await seedProduct(store.storeId, `${suffix}-honey2`, {
      price: 300,
      inventory: 10,
    });
    const ramadanBox = await seedBundle(store.storeId, `${suffix}-ramadan2`, {
      pricingType: 'fixed_price',
      pricingValue: 700,
      items: [
        { productId: dates, quantity: 1 },
        { productId: honey, quantity: 1 },
      ],
    });

    await setStock(honey, 1); // only 1 honey in stock -> floor(1/1) = 1 bundle makeable

    const sessionId = cartSessionId('insufficient-stock');
    const cart = cartClientFor(app, store.storeId, sessionId);

    const res = await cart.addBundleToCart({ bundleId: ramadanBox, quantity: 2 });
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ error: 'insufficient_stock' });

    // Nothing was written on the refused request. A zero-assertion is the
    // one most at risk of passing for the wrong reason: an empty read used to
    // be indistinguishable from "the write has not committed yet". It is not
    // any more — the 422 above was answered only after its transaction
    // settled (middleware/request-transaction.ts), so an empty cart here is
    // a real empty cart.
    const got = await cart.getCart().expect(200);
    expect(got.body.data.cart.bundles).toHaveLength(0);
  });

  it('refuses an inactive bundle', async () => {
    const p = await seedProduct(store.storeId, `${suffix}-inactive-p`, {
      price: 400,
      inventory: 10,
    });
    const bundle = await seedBundle(store.storeId, `${suffix}-inactive`, {
      pricingType: 'fixed_price',
      pricingValue: 350,
      items: [{ productId: p, quantity: 1 }],
      isActive: false,
    });

    const cart = cartClientFor(app, store.storeId, cartSessionId('inactive'));
    const res = await cart.addBundleToCart({ bundleId: bundle, quantity: 1 });
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ error: 'bundle_not_purchasable' });
  });

  it('refuses an expired bundle', async () => {
    const p = await seedProduct(store.storeId, `${suffix}-expired-p`, {
      price: 400,
      inventory: 10,
    });
    const bundle = await seedBundle(store.storeId, `${suffix}-expired`, {
      pricingType: 'fixed_price',
      pricingValue: 350,
      items: [{ productId: p, quantity: 1 }],
      expiresAt: new Date(Date.now() - 24 * 60 * 60 * 1000), // yesterday
    });

    const cart = cartClientFor(app, store.storeId, cartSessionId('expired'));
    const res = await cart.addBundleToCart({ bundleId: bundle, quantity: 1 });
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ error: 'bundle_not_purchasable' });
  });

  it('refuses a bundle with zero component availability', async () => {
    const p = await seedProduct(store.storeId, `${suffix}-zero-p`, { price: 400, inventory: 0 });
    const bundle = await seedBundle(store.storeId, `${suffix}-zero`, {
      pricingType: 'fixed_price',
      pricingValue: 350,
      items: [{ productId: p, quantity: 1 }],
    });

    const cart = cartClientFor(app, store.storeId, cartSessionId('zero'));
    const res = await cart.addBundleToCart({ bundleId: bundle, quantity: 1 });
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ error: 'bundle_not_purchasable' });
  });

  it('cart total equals items + bundles, computed independently', async () => {
    const shirt = await seedProduct(store.storeId, `${suffix}-shirt`, {
      price: 1200,
      inventory: 10,
    });
    const dates = await seedProduct(store.storeId, `${suffix}-dates3`, {
      price: 500,
      inventory: 10,
    });
    const honey = await seedProduct(store.storeId, `${suffix}-honey3`, {
      price: 300,
      inventory: 10,
    });
    const bundle = await seedBundle(store.storeId, `${suffix}-totals`, {
      pricingType: 'fixed_price',
      pricingValue: 700, // componentSum 800, price 700
      items: [
        { productId: dates, quantity: 1 },
        { productId: honey, quantity: 1 },
      ],
    });

    const sessionId = cartSessionId('totals');
    const cart = cartClientFor(app, store.storeId, sessionId);

    await cart.addToCart({ productId: shirt, quantity: 2 }).expect(201); // 1200 * 2 = 2400
    await cart.addBundleToCart({ bundleId: bundle, quantity: 3 }).expect(201); // 700 * 3 = 2100

    const got = await cart.getCart().expect(200);
    const body = got.body.data.cart;

    // Computed independently of the route's own arithmetic.
    const expectedItemsTotal = body.items.reduce(
      (sum: number, item: { quantity: number; product: { price: number } }) =>
        sum + item.product.price * item.quantity,
      0
    );
    const expectedBundlesTotal = body.bundles.reduce(
      (sum: number, b: { unitPrice: number; quantity: number }) => sum + b.unitPrice * b.quantity,
      0
    );
    expect(expectedItemsTotal).toBe(2400);
    expect(expectedBundlesTotal).toBe(2100);
    expect(body.subtotal).toBe(expectedItemsTotal + expectedBundlesTotal);
    expect(body.subtotal).toBe(4500);
  });

  it('a component price change between add and read moves the bundle price', async () => {
    const dates = await seedProduct(store.storeId, `${suffix}-dates4`, {
      price: 500,
      inventory: 10,
    });
    const honey = await seedProduct(store.storeId, `${suffix}-honey4`, {
      price: 300,
      inventory: 10,
    });
    // percentage pricing (10% off), NOT fixed_price — fixed_price clamps to
    // componentSum and would mask a price move on this exact fixture. See
    // the file header of bundle-fixtures.ts / bundle-pricing.ts.
    const bundle = await seedBundle(store.storeId, `${suffix}-pricemove`, {
      pricingType: 'percentage',
      pricingValue: 1000, // 10% off, basis points
      items: [
        { productId: dates, quantity: 1 },
        { productId: honey, quantity: 1 },
      ],
    });

    const sessionId = cartSessionId('pricemove');
    const cart = cartClientFor(app, store.storeId, sessionId);

    await cart.addBundleToCart({ bundleId: bundle, quantity: 1 }).expect(201);

    const before = await cart.getCart().expect(200);
    // componentSum 800, 10% off -> 720
    expect(before.body.data.cart.bundles[0].unitPrice).toBe(720);

    // Component price change AFTER add-to-cart, BEFORE the next read.
    await prisma.product.update({ where: { id: honey }, data: { price: 600 } });

    const after = await cart.getCart().expect(200);
    // componentSum now 1100, 10% off -> 990. Never the stale 720.
    expect(after.body.data.cart.bundles[0].unitPrice).toBe(990);
    expect(after.body.data.cart.bundles[0].total).toBe(990);
  });

  it('removing a bundle leaves the standalone cart_items untouched', async () => {
    const shirt = await seedProduct(store.storeId, `${suffix}-shirt2`, {
      price: 1000,
      inventory: 10,
    });
    const p = await seedProduct(store.storeId, `${suffix}-remove-p`, { price: 400, inventory: 10 });
    const bundle = await seedBundle(store.storeId, `${suffix}-remove`, {
      pricingType: 'fixed_price',
      pricingValue: 350,
      items: [{ productId: p, quantity: 1 }],
    });

    const sessionId = cartSessionId('remove');
    const cart = cartClientFor(app, store.storeId, sessionId);

    await cart.addToCart({ productId: shirt, quantity: 2 }).expect(201);
    await cart.addBundleToCart({ bundleId: bundle, quantity: 1 }).expect(201);

    const withBundle = await cart.getCart().expect(200);
    const cartBundleId = withBundle.body.data.cart.bundles[0].id;
    expect(withBundle.body.data.cart.items).toHaveLength(1);

    await cart.removeBundleFromCart(cartBundleId).expect(200);

    const after = await cart.getCart().expect(200);
    expect(after.body.data.cart.bundles).toHaveLength(0);
    expect(after.body.data.cart.items).toHaveLength(1);
    expect(after.body.data.cart.items[0].productId).toBe(shirt);
    expect(after.body.data.cart.items[0].quantity).toBe(2);
  });
});

/**
 * RULING T3-c — carried forward from Task 3. The cross-tenant guard on
 * `resolveBundle` was previously verified only against a MOCKED Prisma
 * client, which proves the query SHAPE but not that Postgres actually
 * excludes the other tenant's row. This is the first task with real
 * database fixtures, so this block asserts it against a real database:
 * store A must not be able to read, add-to-cart, or otherwise reach store
 * B's bundle — only ever a 404, never store B's data.
 */
describe.skipIf(!hasDb)('bundle cross-tenant isolation (real DB)', () => {
  const suffix = `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  let app: Express;
  let storeA: FixtureStore;
  let storeB: FixtureStore;
  let storeBBundleId: string;

  beforeAll(async () => {
    app = buildBundleTestApp();
    storeA = await seedBundleStore(`${suffix}-a`);
    storeB = await seedBundleStore(`${suffix}-b`);

    const productB = await seedProduct(storeB.storeId, `${suffix}-b-product`, {
      price: 1000,
      inventory: 10,
    });
    storeBBundleId = await seedBundle(storeB.storeId, `${suffix}-b-bundle`, {
      pricingType: 'fixed_price',
      pricingValue: 900,
      items: [{ productId: productB, quantity: 1 }],
    });
  });

  it("resolveBundle refuses store B's bundle scoped to store A (service layer)", async () => {
    await expect(resolveBundleFor(storeA.storeId, storeBBundleId)).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it("adding store B's bundle to store A's cart 404s (route layer)", async () => {
    const cart = cartClientFor(app, storeA.storeId, cartSessionId('xtenant'));
    const res = await cart.addBundleToCart({ bundleId: storeBBundleId, quantity: 1 });
    // No errorHandler is mounted in this test app (see bundle-fixtures.ts) —
    // Express's default handler still honours AppError's `statusCode`, so
    // the status is asserted directly rather than parsing a JSON body.
    expect(res.status).toBe(404);

    // And store A's cart genuinely has nothing — the refused request wrote
    // no CartBundle row under either store.
    const got = await cart.getCart().expect(200);
    expect(got.body.data.cart.bundles).toHaveLength(0);
  });

  it("store B's bundle never appears in store A's public bundle list", async () => {
    const cart = cartClientFor(app, storeA.storeId, cartSessionId('xtenant-public'));
    const res = await cart.publicBundles().expect(200);
    const ids = res.body.data.bundles.map((b: { id: string }) => b.id);
    expect(ids).not.toContain(storeBBundleId);
  });
});

/**
 * RULING T5-b — `CartService.mergeGuestCart` must carry CartBundle rows
 * over on guest->login merge, not silently drop them. `cart_bundles` has a
 * UNIQUE (cart_id, bundle_id) index — the exact same shape as the
 * `cart_items` partial-unique-index trap this whole file exists to guard
 * against — so merging a bundle the logged-in user's OWN cart already has
 * must increment that row's quantity, never INSERT a second one.
 *
 * `mergeGuestCart` has no HTTP route (grep-confirmed unused by any router
 * as of this task), so this exercises the service directly against real
 * Postgres, mirroring how the unit-mocked version in tests/unit/cart.test.ts
 * is structured — but without a mock, so the unique constraint is real.
 */
describe.skipIf(!hasDb)('mergeGuestCart carries bundles across (real DB)', () => {
  const suffix = `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  let store: FixtureStore;
  let customerId: string;

  beforeAll(async () => {
    store = await seedBundleStore(`${suffix}-merge`);
    customerId = await seedCustomer(`${suffix}-merge`);
  });

  it("merges a shared bundle's quantity without violating the (cartId, bundleId) unique index, and creates a new line for a bundle only the guest had", async () => {
    const p1 = await seedProduct(store.storeId, `${suffix}-merge-p1`, {
      price: 500,
      inventory: 20,
    });
    const p2 = await seedProduct(store.storeId, `${suffix}-merge-p2`, {
      price: 300,
      inventory: 20,
    });
    const bundleShared = await seedBundle(store.storeId, `${suffix}-merge-shared`, {
      pricingType: 'fixed_price',
      pricingValue: 400,
      items: [{ productId: p1, quantity: 1 }],
    });
    const bundleGuestOnly = await seedBundle(store.storeId, `${suffix}-merge-guestonly`, {
      pricingType: 'fixed_price',
      pricingValue: 250,
      items: [{ productId: p2, quantity: 1 }],
    });

    const guestSessionId = cartSessionId('merge-guest');

    // Guest cart: both bundles, qty 1 each.
    const guestCart = await prisma.cart.create({
      data: { storeId: store.storeId, sessionId: guestSessionId, customerId: null },
    });
    await prisma.cartBundle.create({
      data: { cartId: guestCart.id, bundleId: bundleShared, quantity: 1 },
    });
    await prisma.cartBundle.create({
      data: { cartId: guestCart.id, bundleId: bundleGuestOnly, quantity: 1 },
    });

    // User cart: already has the SHARED bundle at qty 2 — this is the
    // unique-constraint trap. If mergeGuestCart naively INSERTed the
    // guest's row instead of incrementing this one, this would 500 on the
    // (cartId, bundleId) unique index.
    const userCart = await prisma.cart.create({
      data: { storeId: store.storeId, sessionId: cartSessionId('merge-user'), customerId },
    });
    await prisma.cartBundle.create({
      data: { cartId: userCart.id, bundleId: bundleShared, quantity: 2 },
    });

    await CartService.mergeGuestCart(store.storeId, guestSessionId, customerId);

    const finalBundles = await prisma.cartBundle.findMany({
      where: { cartId: userCart.id },
      orderBy: { bundleId: 'asc' },
    });

    const shared = finalBundles.find(b => b.bundleId === bundleShared);
    const guestOnly = finalBundles.find(b => b.bundleId === bundleGuestOnly);

    // Exactly one row per bundleId — never two for the shared bundle.
    expect(finalBundles).toHaveLength(2);
    expect(shared?.quantity).toBe(3); // 2 (user) + 1 (guest), merged in place
    expect(guestOnly?.quantity).toBe(1); // guest-only line created fresh

    // Guest cart is gone (cascades its own CartBundle rows).
    const guestCartAfter = await prisma.cart.findUnique({ where: { id: guestCart.id } });
    expect(guestCartAfter).toBeNull();
  });
});
