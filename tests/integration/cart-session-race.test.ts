/**
 * The cart's unique-race recovery paths, exercised against real Postgres.
 *
 * THE REGRESSION THIS FILE EXISTS TO PREVENT
 *
 * `CartService.getOrCreate` has always carried a "create, and if a concurrent
 * request beat us to it, re-read the winner's row" recovery. Inside the
 * interactive transaction `middleware/tenant-context.ts` opens for every
 * store-scoped request, that recovery could NEVER run: Postgres puts a
 * transaction into ABORTED state the instant any statement in it errors, so
 * the losing `create`'s P2002 killed the transaction and the recovery
 * `findFirst` threw SQLSTATE 25P02 ("current transaction is aborted, commands
 * ignored until end of transaction block"). The customer got a 500 from
 * `GET /cart`, `POST /cart/items` or `POST /cart/bundles` — the guard written
 * to absorb the race was the thing that surfaced it.
 *
 * The race was routine, not exotic. `tenantContext` USED TO resolve its
 * transaction on `res.on('finish')`, i.e. AFTER the response had been flushed
 * to the client, so even a strictly sequential client could start its next
 * request before the previous one's cart row had committed. That is how this
 * reached CI as an intermittent 500 in `cart-bundles.test.ts` (~1 sequential
 * request in 30 on a developer machine, far more on a loaded runner) rather
 * than as an obvious always-red failure. That half is now fixed at the source:
 * `middleware/request-transaction.ts` commits BEFORE the response is sent on
 * the buffered lane, which is why these suites no longer need a
 * commit barrier between a write and the read-back that follows it.
 *
 * The savepoint fix below is independent of that and still load-bearing: two
 * requests genuinely IN FLIGHT AT ONCE still race the same unique indexes,
 * and commit-before-respond does nothing for concurrency.
 *
 * Concurrency is the deterministic form of the same race, so that is what
 * these tests drive: several requests for ONE session, in flight at once. Each
 * one covers a different `create` that runs on the ambient transaction and can
 * lose a unique race:
 *   - `carts (store_id, session_id)`            → getOrCreate
 *   - `cart_items (cart_id, product_id, …)`     → addItem's writeLine
 *   - `cart_bundles (cart_id, bundle_id)`       → addBundle's writeBundleLine
 *
 * Every one is a live customer-facing surface (`cart.routes.ts` has no
 * `authenticate`), and the fix is the same in all three: `lib/savepoint.ts`.
 *
 * Real Postgres throughout — no mocked Prisma client. A mock cannot express
 * transaction abort semantics, which is the entire subject of this file.
 * Gated on `hasDb` like every other real-DB suite under tests/integration.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import type { Express } from 'express';
import {
  hasDb,
  buildBundleTestApp,
  seedBundleStore,
  seedProduct,
  seedBundle,
  cartClientFor,
  cartSessionId,
  type FixtureStore,
} from '../helpers/bundle-fixtures';

describe.skipIf(!hasDb)('cart unique-race recovery under the ambient tenant transaction', () => {
  const suffix = `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  let app: Express;
  let store: FixtureStore;
  let productId: string;
  let bundleId: string;

  beforeAll(async () => {
    app = buildBundleTestApp();
    store = await seedBundleStore(suffix);
    productId = await seedProduct(store.storeId, `${suffix}-race-product`, {
      price: 1000,
      inventory: 500,
    });
    bundleId = await seedBundle(store.storeId, `${suffix}-race-bundle`, {
      pricingType: 'fixed_price',
      pricingValue: 900,
      items: [{ productId, quantity: 1 }],
    });
  });

  it('concurrent first reads of one session all 200 — the losing cart insert recovers, never 500s', async () => {
    const sessionId = cartSessionId('race-getorcreate');
    const cart = cartClientFor(app, store.storeId, sessionId);

    // No cart row exists yet, so every one of these findFirst's misses and
    // every one tries to INSERT. Exactly one wins the
    // `carts (store_id, session_id)` unique index; the losers must re-read the
    // winner's row rather than die on an aborted transaction.
    const responses = await Promise.all([cart.getCart(), cart.getCart(), cart.getCart()]);

    expect(responses.map(r => r.status)).toEqual([200, 200, 200]);
    // All three describe the SAME cart — the recovery returns the winner's
    // row, it does not invent a second cart for the session.
    const ids = responses.map(r => r.body.data.cart.id);
    expect(new Set(ids).size).toBe(1);
  });

  it('concurrent adds of the same product all 201 and merge into one line at the summed quantity', async () => {
    const sessionId = cartSessionId('race-additem');
    const cart = cartClientFor(app, store.storeId, sessionId);
    await cart.getCart().expect(200);
    // ^ this 200 means the cart row is COMMITTED (commit-before-respond, see
    // middleware/request-transaction.ts), so this test isolates the
    // cart_items race rather than also racing the cart insert.

    const responses = await Promise.all([
      cart.addToCart({ productId, quantity: 1 }),
      cart.addToCart({ productId, quantity: 1 }),
      cart.addToCart({ productId, quantity: 1 }),
    ]);

    expect(responses.map(r => r.status)).toEqual([201, 201, 201]);

    // The losers merged rather than being dropped: one line, quantity 3. A
    // recovery that swallowed the loser would leave quantity 1 or 2 here.
    const got = await cart.getCart().expect(200);
    expect(got.body.data.cart.items).toHaveLength(1);
    expect(got.body.data.cart.items[0].quantity).toBe(3);
  });

  it('concurrent adds of the same bundle all 201 and merge into one line at the summed quantity', async () => {
    const sessionId = cartSessionId('race-addbundle');
    const cart = cartClientFor(app, store.storeId, sessionId);
    await cart.getCart().expect(200);

    const responses = await Promise.all([
      cart.addBundleToCart({ bundleId, quantity: 1 }),
      cart.addBundleToCart({ bundleId, quantity: 1 }),
      cart.addBundleToCart({ bundleId, quantity: 1 }),
    ]);

    expect(responses.map(r => r.status)).toEqual([201, 201, 201]);

    const got = await cart.getCart().expect(200);
    expect(got.body.data.cart.bundles).toHaveLength(1);
    expect(got.body.data.cart.bundles[0].quantity).toBe(3);
    // Priced live off the bundle, never the component sum — 900 fils x 3.
    expect(got.body.data.cart.bundles[0].total).toBe(2700);
  });
});
