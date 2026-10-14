/**
 * B0 Task 5: per-item personalisation, end to end against real Postgres.
 *
 * A cart line is (cart, product, variant, note): "Sara" and "Omar" on the same
 * abaya are two lines; the same note merges. The DB enforces it with the two
 * partial unique EXPRESSION indexes rebuilt in 20261016000500_personalisation
 * (COALESCE(note, '')), and every path that writes or merges a line (single
 * add, the bulk sync, the guest→login merge) carries the note as identity.
 * The note lands on the order line as `personalisation`, and the storefront
 * order now snapshots `variantName` (Arabic title when the buyer ordered in
 * Arabic).
 *
 * Adds go over HTTP through the store-scoped cart mount (`tenantContext`, the
 * ambient request transaction), so the concurrent-add case exercises the
 * savepoint + P2002 recovery on the NEW unique key. Cart sessions come from
 * `cartSessionId()` (retry-safe, see repo CLAUDE.md).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { withRlsBypass } from '@ebda/database';
import { CartService } from '@api/services/cart.service';
import { errorHandler } from '@api/middleware/error-handler';
import { OrderService } from '@api/services/order.service';
import {
  hasDb,
  buildBundleTestApp,
  seedBundleStore,
  seedProduct,
  cartClientFor,
  cartSessionId,
  seedCustomer,
  DEFAULT_TEST_SHIPPING_ADDRESS,
  type FixtureStore,
} from '../helpers/bundle-fixtures';

type Line = { productId: string; variantId: string | null; note: string | null; quantity: number };

describe.skipIf(!hasDb)('cart personalisation (line identity, enforcement, order snapshot)', () => {
  const suffix = `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  let app: Express;
  let store: FixtureStore;
  let productId: string; // optional personalisation, has a variant
  let variantId: string;
  let requiredId: string; // required, maxLength 10
  let plainId: string; // personalisation off

  const setPersonalisation = (id: string, value: object) =>
    withRlsBypass(tx => tx.product.update({ where: { id }, data: { personalisation: value } }));

  beforeAll(async () => {
    app = buildBundleTestApp();
    // The real envelope, so a Zod failure is a 400 like production (not Express's default 500).
    app.use(errorHandler);
    store = await seedBundleStore(`perso-${suffix}`);
    productId = await seedProduct(store.storeId, `${suffix}-abaya`, { price: 5000, inventory: 0 });
    requiredId = await seedProduct(store.storeId, `${suffix}-ring`, { price: 3000, inventory: 50 });
    plainId = await seedProduct(store.storeId, `${suffix}-plain`, { price: 1000, inventory: 50 });
    variantId = await withRlsBypass(async tx => {
      const v = await tx.productVariant.create({
        data: { productId, title: 'M / Sand', titleAr: 'وسط / رملي', inventory: 50, price: 5200 },
      });
      return v.id;
    });
    await setPersonalisation(productId, {
      enabled: true,
      label: 'Name to embroider',
      labelAr: 'الاسم للتطريز',
      maxLength: 12,
      required: false,
    });
    await setPersonalisation(requiredId, {
      enabled: true,
      label: 'Name',
      labelAr: 'الاسم',
      maxLength: 10,
      required: true,
    });
  });

  const linesOf = (cart: { items: Line[] }, pid: string) =>
    cart.items
      .filter(i => i.productId === pid)
      .map(l => [l.note, l.quantity] as const)
      .sort();

  it('personalised lines stay separate; the same note merges', async () => {
    const cart = cartClientFor(app, store.storeId, cartSessionId('perso-separate'));
    await cart.addToCart({ productId, variantId, quantity: 1, note: 'Sara' }).expect(201);
    await cart.addToCart({ productId, variantId, quantity: 1, note: 'Omar' }).expect(201);
    // Same text after cleaning (spaces + a bidi override) merges into "Sara".
    await cart.addToCart({ productId, variantId, quantity: 2, note: '  Sara‮ ' }).expect(201);
    // No note is its own line, distinct from both names.
    await cart.addToCart({ productId, variantId, quantity: 1 }).expect(201);
    const got = await cart.getCart().expect(200);
    // (default sort: the null line stringifies to ",1" and sorts first)
    expect(linesOf(got.body.data.cart, productId)).toEqual([
      [null, 1],
      ['Omar', 1],
      ['Sara', 3],
    ]);
  });

  it('concurrent adds of the same (product, variant, note) merge into one line at the summed quantity', async () => {
    const cart = cartClientFor(app, store.storeId, cartSessionId('perso-race'));
    await cart.getCart().expect(200);
    const body = { productId, variantId, quantity: 1, note: 'Sara' };
    const responses = await Promise.all([
      cart.addToCart(body),
      cart.addToCart(body),
      cart.addToCart(body),
    ]);
    expect(responses.map(r => r.status)).toEqual([201, 201, 201]);
    const got = await cart.getCart().expect(200);
    expect(linesOf(got.body.data.cart, productId)).toEqual([['Sara', 3]]);
  });

  it('required personalisation is enforced server-side (missing and too long are 400)', async () => {
    const cart = cartClientFor(app, store.storeId, cartSessionId('perso-required'));
    await cart.addToCart({ productId: requiredId, quantity: 1 }).expect(400);
    await cart.addToCart({ productId: requiredId, quantity: 1, note: '   ' }).expect(400);
    await cart.addToCart({ productId: requiredId, quantity: 1, note: 'x'.repeat(11) }).expect(400);
    await cart.addToCart({ productId: requiredId, quantity: 1, note: 'x'.repeat(10) }).expect(201);
    // Over the 400-char edge cap is a schema 400 before cleaning.
    await cart.addToCart({ productId: requiredId, quantity: 1, note: 'x'.repeat(401) }).expect(400);
  });

  it('a note on a product without personalisation is dropped (no line split)', async () => {
    const cart = cartClientFor(app, store.storeId, cartSessionId('perso-off'));
    await cart.addToCart({ productId: plainId, quantity: 1, note: 'Sara' }).expect(201);
    await cart.addToCart({ productId: plainId, quantity: 1, note: 'Omar' }).expect(201);
    const got = await cart.getCart().expect(200);
    expect(linesOf(got.body.data.cart, plainId)).toEqual([[null, 2]]);
  });

  it('the bulk sync keeps notes as line identity and skips a line that breaks the rule', async () => {
    const sessionId = cartSessionId('perso-sync');
    const cart = cartClientFor(app, store.storeId, sessionId);
    await cart.addToCart({ productId, variantId, quantity: 1, note: 'Sara' }).expect(201);
    await request(app)
      .post(`/api/v1/stores/${store.storeId}/cart/sync`)
      .set('x-session-id', sessionId)
      .send({
        items: [
          { productId, variantId, quantity: 1, note: 'Sara' },
          { productId, variantId, quantity: 1, note: 'Omar' },
          { productId, variantId, quantity: 1, note: 'Omar ' },
          { productId: requiredId, quantity: 1 }, // required but empty → skipped, not a 400
        ],
      })
      .expect(200);
    const got = await cart.getCart().expect(200);
    expect(linesOf(got.body.data.cart, productId)).toEqual([
      ['Omar', 2],
      ['Sara', 2],
    ]);
    expect(linesOf(got.body.data.cart, requiredId)).toEqual([]);
  });

  it('the guest→login merge keeps "Sara" and "Omar" apart and merges same-note lines', async () => {
    const customerId = await seedCustomer(
      `perso-merge-${suffix}-${Math.random().toString(36).slice(2, 6)}`
    );
    const guestSession = cartSessionId('perso-guest');
    const userSession = cartSessionId('perso-user');
    await CartService.addItem(
      store.storeId,
      userSession,
      productId,
      1,
      customerId,
      variantId,
      'Sara'
    );
    await CartService.addItem(
      store.storeId,
      guestSession,
      productId,
      2,
      undefined,
      variantId,
      'Sara'
    );
    await CartService.addItem(
      store.storeId,
      guestSession,
      productId,
      1,
      undefined,
      variantId,
      'Omar'
    );
    const merged = await CartService.mergeGuestCart(store.storeId, guestSession, customerId);
    expect(
      (merged?.items ?? [])
        .filter(i => i.productId === productId)
        .map(i => [i.note, i.quantity])
        .sort()
    ).toEqual([
      ['Omar', 1],
      ['Sara', 3],
    ]);
  });

  it('note and variantName land on the order line (Arabic title for an Arabic order)', async () => {
    const sessionId = cartSessionId('perso-order');
    await CartService.addItem(store.storeId, sessionId, productId, 1, undefined, variantId, 'Sara');
    await CartService.addItem(store.storeId, sessionId, productId, 1, undefined, variantId, 'Omar');
    await CartService.addItem(store.storeId, sessionId, plainId, 1);
    const order = await OrderService.create(store.storeId, undefined, sessionId, {
      shippingAddress: DEFAULT_TEST_SHIPPING_ADDRESS,
      paymentMethod: 'paymob',
      locale: 'ar',
    });
    const lines = order.items.filter(i => i.variantId === variantId);
    expect(lines.map(l => l.personalisation).sort()).toEqual(['Omar', 'Sara']);
    expect(lines.every(l => l.variantName === 'وسط / رملي')).toBe(true);
    const plain = order.items.find(i => i.productId === plainId)!;
    expect(plain.personalisation).toBeNull();
    expect(plain.variantName).toBeNull();
  });

  it('an English order snapshots the English variant title', async () => {
    const sessionId = cartSessionId('perso-order-en');
    await CartService.addItem(store.storeId, sessionId, productId, 1, undefined, variantId, 'Sara');
    const order = await OrderService.create(store.storeId, undefined, sessionId, {
      shippingAddress: DEFAULT_TEST_SHIPPING_ADDRESS,
      paymentMethod: 'paymob',
      locale: 'en',
    });
    expect(order.items[0].variantName).toBe('M / Sand');
    expect(order.items[0].personalisation).toBe('Sara');
  });

  it('the DB itself refuses a duplicate (cart, product, variant, note) line', async () => {
    const sessionId = cartSessionId('perso-index');
    await CartService.addItem(store.storeId, sessionId, productId, 1, undefined, variantId, 'Sara');
    const cartId = await withRlsBypass(async tx => {
      const c = await tx.cart.findFirstOrThrow({ where: { storeId: store.storeId, sessionId } });
      return c.id;
    });
    await expect(
      withRlsBypass(tx =>
        tx.cartItem.create({ data: { cartId, productId, variantId, note: 'Sara', quantity: 1 } })
      )
    ).rejects.toMatchObject({ code: 'P2002' });
    // A different note on the same variant is allowed.
    await withRlsBypass(tx =>
      tx.cartItem.create({ data: { cartId, productId, variantId, note: 'Omar', quantity: 1 } })
    );
  });
});
