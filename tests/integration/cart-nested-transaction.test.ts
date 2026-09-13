/**
 * `POST /stores/:storeId/cart/sync` as the FIRST request of a fresh session.
 *
 * THE DEFECT
 *
 * `CartService.addItems` opened `prisma.$transaction(...)` unconditionally.
 * `$transaction` is deliberately NOT proxied — `isProxiedProp` in
 * `packages/database` rejects every `$`-prefixed name but the raw helpers — so
 * it runs on a DIFFERENT connection from the ambient request transaction that
 * `tenantContext` opens. `addItems` calls `getOrCreate` first, which writes the
 * new `carts` row THROUGH the proxy, onto that ambient transaction, where it
 * stays uncommitted. The nested transaction's `cartItem.create` then pointed
 * its `cart_items.cart_id` FK at a row it could not see → P2003.
 *
 * P2003 is in neither `RETRYABLE_CODES` nor the `extraRetryCodes: ['P2002']`
 * the call passed, so every attempt failed and it surfaced as a 500. And
 * because `tenantContext` rolls back on a 5xx, the cart row was discarded too
 * — so a client retry reproduced it identically rather than self-healing.
 *
 * WHY IT SURVIVED THREE SEPARATE REPORTS
 *
 * The first-party storefront calls the sibling `/public/cart/sync`, which is
 * mounted OUTSIDE `tenantContext`, so `hasTenantContext()` is false there and
 * the own-transaction branch is correct. Only a store-scoped caller — POS,
 * admin, an agent surface — reaches the trap. `addItem` and `addBundle` were
 * both fixed for this; `addItems` was edited twice in the same PRs without it.
 *
 * WHY THE ORDERING MATTERS
 *
 * A prior `GET /cart` commits the cart in an earlier request and masks the
 * whole thing. Every one of these tests uses a session that has NEVER been
 * seen, and syncs as its first request — that is the case the existing suites
 * never exercise.
 *
 * Real Postgres throughout. A mocked Prisma client has no foreign keys and no
 * connection identity, which is the entire subject of this file.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { prisma } from '@force/database';
import {
  hasDb,
  buildBundleTestApp,
  seedBundleStore,
  seedProduct,
  cartSessionId,
  type FixtureStore,
} from '../helpers/bundle-fixtures';

describe.skipIf(!hasDb)('addItems under the ambient tenant transaction', () => {
  const suffix = `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  let app: Express;
  let store: FixtureStore;
  let productA: string;
  let productB: string;

  beforeAll(async () => {
    app = buildBundleTestApp();
    store = await seedBundleStore(suffix);
    productA = await seedProduct(store.storeId, `${suffix}-sync-a`, {
      inventory: 500,
      price: 2_500,
    });
    productB = await seedProduct(store.storeId, `${suffix}-sync-b`, {
      inventory: 500,
      price: 2_500,
    });
  });

  const sync = (sessionId: string, items: Array<{ productId: string; quantity: number }>) =>
    request(app)
      .post(`/api/v1/stores/${store.storeId}/cart/sync`)
      .set('x-session-id', sessionId)
      .send({ items });

  it('does not 500 on a session whose cart has never been committed', async () => {
    const sessionId = cartSessionId('sync-first-request');

    const res = await sync(sessionId, [{ productId: productA, quantity: 2 }]);

    // The whole finding in one assertion: this was a 500 carrying P2003.
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.cart.items).toHaveLength(1);
    expect(res.body.data.cart.items[0].quantity).toBe(2);
  });

  it('writes the lines onto the SAME transaction that created the cart', async () => {
    // The negative control for the assertion above. A 200 could also come from
    // a sync that silently wrote nothing, so this reads the rows back and
    // checks the cart the items point at is the one this session owns.
    const sessionId = cartSessionId('sync-same-tx');

    const res = await sync(sessionId, [
      { productId: productA, quantity: 1 },
      { productId: productB, quantity: 3 },
    ]);
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const cart = await prisma.cart.findFirst({
      where: { storeId: store.storeId, sessionId },
      include: { items: true },
    });
    expect(cart, 'the cart was rolled back — the request 5xx’d').not.toBeNull();
    expect(cart!.items).toHaveLength(2);
    expect(new Set(cart!.items.map(i => i.productId))).toEqual(new Set([productA, productB]));
    expect(cart!.items.every(i => i.cartId === cart!.id)).toBe(true);
  });

  it('merges into an existing line rather than duplicating it', async () => {
    const sessionId = cartSessionId('sync-merge');

    expect((await sync(sessionId, [{ productId: productA, quantity: 2 }])).status).toBe(200);
    const res = await sync(sessionId, [{ productId: productA, quantity: 3 }]);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data.cart.items).toHaveLength(1);
    expect(res.body.data.cart.items[0].quantity).toBe(5);
  });

  it('survives concurrent syncs of the same line on one fresh session', async () => {
    // Two requests in flight at once on a session with no committed cart:
    // both race `carts (store_id, session_id)` in getOrCreate AND
    // `cart_items (cart_id, product_id, …)` in the loop. The savepoint is what
    // lets the loser recover inside a transaction it does not own.
    const sessionId = cartSessionId('sync-concurrent');

    const results = await Promise.all([
      sync(sessionId, [{ productId: productA, quantity: 1 }]),
      sync(sessionId, [{ productId: productA, quantity: 1 }]),
    ]);

    for (const res of results) {
      expect(res.status, JSON.stringify(res.body)).toBe(200);
    }
    const cart = await prisma.cart.findFirst({
      where: { storeId: store.storeId, sessionId },
      include: { items: true },
    });
    expect(cart!.items).toHaveLength(1);
    // Both adds must land — a retry that re-ran the loop from a clean
    // savepoint must not drop one, and must not double-apply the other.
    expect(cart!.items[0].quantity).toBe(2);
  });

  it('recovers a same-line unique race inside a transaction it does not own', async () => {
    // This is the savepoint's own case, and it is NOT the test above: there,
    // the two requests raced `carts (store_id, session_id)` in getOrCreate,
    // which carries its own savepoint. To reach `writeItems`' savepoint the
    // cart has to already exist, so the only thing left to race is
    // `cart_items (cart_id, product_id, variant_id)`.
    //
    // Both requests read no existing line and both INSERT; the loser gets
    // P2002 on the ambient transaction, which Postgres puts into ABORTED
    // state. Without `withSavepoint` the retry's `findMany` would throw 25P02
    // ("current transaction is aborted") and the customer would get a 500 —
    // the guard written to absorb the race surfacing it instead.
    const sessionId = cartSessionId('sync-line-race');

    // Commit the cart first, so getOrCreate has nothing to race.
    expect((await sync(sessionId, [{ productId: productA, quantity: 1 }])).status).toBe(200);

    const results = await Promise.all([
      sync(sessionId, [{ productId: productB, quantity: 1 }]),
      sync(sessionId, [{ productId: productB, quantity: 1 }]),
    ]);

    for (const res of results) {
      expect(res.status, JSON.stringify(res.body)).toBe(200);
    }
    const cart = await prisma.cart.findFirst({
      where: { storeId: store.storeId, sessionId },
      include: { items: true },
    });
    const lineB = cart!.items.filter(i => i.productId === productB);
    expect(lineB).toHaveLength(1);
    // Both adds land: the loser's retry re-reads the winner's row and merges.
    expect(lineB[0].quantity).toBe(2);
  });

  it('still refuses an over-inventory sync with a 400, not a 500', async () => {
    // The branch must not have swallowed business refusals into the
    // transaction plumbing.
    const sessionId = cartSessionId('sync-inventory');
    const scarce = await seedProduct(store.storeId, `${suffix}-scarce`, {
      inventory: 1,
      price: 1_000,
    });

    const res = await sync(sessionId, [{ productId: scarce, quantity: 5 }]);

    expect(res.status).toBe(400);
  });
});

/**
 * `mergeGuestCart` when the customer has no cart of their own.
 *
 * `carts` carries a FULL unique index on `(store_id, session_id)`. The old code
 * created a second cart with the guest's OWN sessionId while the guest row was
 * still live, which is a 100% collision on every call down this branch — not a
 * race. It had never been executed against the real index: the function has no
 * HTTP route, the only real-DB test always pre-created a user cart, and the
 * unit tests mock Prisma, where a unique index does not exist.
 */
describe.skipIf(!hasDb)('mergeGuestCart with no pre-existing customer cart', () => {
  const suffix = `${Date.now()}-${process.pid}-m${Math.random().toString(36).slice(2, 8)}`;
  let store: FixtureStore;
  let productId: string;

  beforeAll(async () => {
    store = await seedBundleStore(suffix);
    productId = await seedProduct(store.storeId, `${suffix}-merge`, {
      inventory: 50,
      price: 3_000,
    });
  });

  it('promotes the guest cart instead of colliding on the unique index', async () => {
    const { CartService } = await import('@api/services/cart.service');
    const guestSession = cartSessionId('merge-promote');

    const guestCart = await prisma.cart.create({
      data: { storeId: store.storeId, sessionId: guestSession },
    });
    await prisma.cartItem.create({
      data: { cartId: guestCart.id, productId, quantity: 4 },
    });

    const customer = await prisma.user.create({
      data: {
        email: `merge-customer-${suffix}@example.com`,
        passwordHash: 'not-a-real-hash',
        role: 'customer',
        firstName: 'Merge',
        lastName: 'Customer',
      },
    });

    // Before the fix this threw P2002 on carts_store_id_session_id_key.
    const merged = await CartService.mergeGuestCart(store.storeId, guestSession, customer.id);

    expect(merged, 'merge returned nothing — it collided').not.toBeNull();
    expect(merged!.id).toBe(guestCart.id);
    expect(merged!.customerId).toBe(customer.id);
    expect(merged!.items).toHaveLength(1);
    expect(merged!.items[0].quantity).toBe(4);

    // Exactly one cart for this session — not two, and not zero.
    const carts = await prisma.cart.findMany({
      where: { storeId: store.storeId, sessionId: guestSession },
    });
    expect(carts).toHaveLength(1);
  });
});
