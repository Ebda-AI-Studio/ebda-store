/**
 * Abandoned-cart detection accounts for `cart_bundles` (product-bundles
 * gap 2).
 *
 * Before this change, `AbandonedCartService.detectNewAbandonments`'s
 * candidate query required `items: { some: {} }` — a `CartBundle`-only
 * cart (a bundle is NEVER expanded into `cart_items`, see
 * `cart.service.ts`'s file doc comment) has zero `CartItem` rows and was
 * therefore invisible to abandoned-cart recovery, a silent revenue hole
 * that grows with `bundles` adoption. This suite proves:
 *
 *   1. a bundle-only cart IS detected as abandoned;
 *   2. its `AbandonedCart.cartItems` snapshot describes the bundle as ONE
 *      line, priced at the bundle's sale price — NEVER the sum of its
 *      per-component allocated shares (`componentSum`);
 *   3. `cartItemCount`/`cartTotal` fold in bundle lines correctly for a
 *      MIXED cart (loose items + a bundle);
 *   4. a store withOUT the `bundles` feature (so it can never have a
 *      `CartBundle` row — bundle creation is itself feature-gated) is
 *      detected exactly as before the change — proving the new OR-arm on
 *      the candidate query and the extra `bundles` include are a no-op for
 *      every such store.
 *
 * Real Postgres throughout (RULING C6: no Prisma command here ever
 * connects to a database — only the ordinary Prisma client against an
 * already-migrated schema). Gated on `hasDb` so this suite skips cleanly
 * wherever no real database is configured, same as every other real-DB
 * suite under tests/integration.
 */
import { describe, it, expect } from 'vitest';
import { prisma, withRlsBypass } from '@ebda/database';
import {
  hasDb,
  seedBundleStore,
  seedStoreWithoutBundlesFeature,
  seedProduct,
  seedBundle,
  seedCustomer,
  resolveBundleFor,
  cartSessionId,
  type FixtureStore,
} from '../helpers/bundle-fixtures';
import { abandonedCartService } from '@api/services/abandoned-cart.service';

/** >1h old — past `ABANDONMENT_THRESHOLD_MS` in abandoned-cart.service.ts. */
const STALE_ACTIVITY = new Date(Date.now() - 2 * 60 * 60 * 1000);

/** Explicitly enables `abandoned_cart` for a store — the detection sweep
 *  reads `StoreFeature` rows directly (not the plan-baseline resolver), so
 *  every fixture store needs this row regardless of plan. */
async function enableAbandonedCart(storeId: string): Promise<void> {
  await withRlsBypass(tx =>
    tx.storeFeature.create({ data: { storeId, featureKey: 'abandoned_cart', enabled: true } })
  );
}

async function createStaleCart(
  storeId: string,
  sessionId: string,
  customerId: string
): Promise<string> {
  // Bare `prisma` — matches tests/integration/cart-bundles.test.ts, which
  // creates Cart/CartItem/CartBundle rows directly without `withRlsBypass`.
  const cart = await prisma.cart.create({
    data: { storeId, sessionId, customerId, lastActivityAt: STALE_ACTIVITY },
  });
  return cart.id;
}

describe.skipIf(!hasDb)('abandoned-cart detection accounts for cart_bundles', () => {
  const suffix = `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;

  it('detects a bundle-only cart as abandoned and names the bundle at the bundle price, never componentSum', async () => {
    const store: FixtureStore = await seedBundleStore(`${suffix}-a`);
    await enableAbandonedCart(store.storeId);
    const customerId = await seedCustomer(`${suffix}-a`);

    const productId = await seedProduct(store.storeId, `${suffix}-a`, {
      price: 500,
      inventory: 20,
    });
    const bundleId = await seedBundle(store.storeId, `${suffix}-a`, {
      name: `Abandoned Bundle ${suffix}-a`,
      pricingType: 'fixed_price',
      pricingValue: 400,
      items: [{ productId, quantity: 1 }],
    });
    const resolved = await resolveBundleFor(store.storeId, bundleId);
    // Sanity: this bundle IS discounted — otherwise a test that accidentally
    // read `componentSum` instead of `price` would pass for the wrong reason.
    expect(resolved.price).toBeLessThan(resolved.componentSum);

    const cartId = await createStaleCart(store.storeId, cartSessionId('stale-a'), customerId);
    await prisma.cartBundle.create({ data: { cartId, bundleId, quantity: 2 } });

    await abandonedCartService.detectNewAbandonments();

    const record = await prisma.abandonedCart.findUnique({ where: { cartId } });
    expect(record).not.toBeNull();
    expect(record!.cartItemCount).toBe(1); // one BOX line, not one-per-component
    expect(record!.cartTotal).toBe(resolved.price * 2); // bundle price x qty — never componentSum

    const items = record!.cartItems as Array<{
      productName: string;
      price: number;
      quantity: number;
      isBundle?: boolean;
    }>;
    expect(items).toHaveLength(1);
    expect(items[0].productName).toBe(resolved.name);
    expect(items[0].price).toBe(resolved.price);
    expect(items[0].quantity).toBe(2);
    expect(items[0].isBundle).toBe(true);
  });

  it('folds a bundle line into cartItemCount/cartTotal alongside loose items on a mixed cart', async () => {
    const store: FixtureStore = await seedBundleStore(`${suffix}-b`);
    await enableAbandonedCart(store.storeId);
    const customerId = await seedCustomer(`${suffix}-b`);

    const looseProductId = await seedProduct(store.storeId, `${suffix}-b-loose`, {
      price: 300,
      inventory: 20,
    });
    const componentProductId = await seedProduct(store.storeId, `${suffix}-b-component`, {
      price: 500,
      inventory: 20,
    });
    const bundleId = await seedBundle(store.storeId, `${suffix}-b`, {
      name: `Mixed Cart Bundle ${suffix}-b`,
      pricingType: 'fixed_price',
      pricingValue: 400,
      items: [{ productId: componentProductId, quantity: 1 }],
    });
    const resolved = await resolveBundleFor(store.storeId, bundleId);

    const cartId = await createStaleCart(store.storeId, cartSessionId('stale-b'), customerId);
    await prisma.cartItem.create({ data: { cartId, productId: looseProductId, quantity: 3 } });
    await prisma.cartBundle.create({ data: { cartId, bundleId, quantity: 1 } });

    await abandonedCartService.detectNewAbandonments();

    const record = await prisma.abandonedCart.findUnique({ where: { cartId } });
    expect(record).not.toBeNull();
    expect(record!.cartItemCount).toBe(2); // 1 loose line + 1 bundle line
    expect(record!.cartTotal).toBe(300 * 3 + resolved.price * 1);
  });

  it('a store without the bundles feature detects a loose-item cart exactly as before (bundles-awareness is a no-op there)', async () => {
    const store: FixtureStore = await seedStoreWithoutBundlesFeature(`${suffix}-c`);
    await enableAbandonedCart(store.storeId);
    const customerId = await seedCustomer(`${suffix}-c`);

    const productId = await seedProduct(store.storeId, `${suffix}-c`, {
      price: 250,
      inventory: 20,
    });

    const cartId = await createStaleCart(store.storeId, cartSessionId('stale-c'), customerId);
    await prisma.cartItem.create({ data: { cartId, productId, quantity: 2 } });

    await abandonedCartService.detectNewAbandonments();

    const record = await prisma.abandonedCart.findUnique({ where: { cartId } });
    expect(record).not.toBeNull();
    expect(record!.cartItemCount).toBe(1);
    expect(record!.cartTotal).toBe(250 * 2);
    const items = record!.cartItems as Array<{ isBundle?: boolean }>;
    expect(items.every(i => !i.isBundle)).toBe(true);
  });
});
