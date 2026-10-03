/**
 * Order creation expands bundles into component lines (Task 6, product
 * bundles) — the money path.
 *
 * The cart holds bundles as their own `CartBundle` rows, never expanded
 * (Task 5). This file proves the OTHER half: at order creation, every cart
 * bundle expands into ordinary `OrderItem` component lines, tagged with
 * `bundleId`/`bundleGroupId`/`bundleName`/`bundleNameAr`, so stock,
 * scan-to-pick, returns, backorders and per-line COGS all keep working with
 * no bundle awareness anywhere downstream.
 *
 * Two money invariants are the point of this file, asserted directly:
 *   1. Σ(line.total) across a bundle GROUP === bundlePrice (a group is one
 *      box — "one bundleGroupId per box" is what makes this exact number
 *      the per-box price rather than a multi-box total).
 *   2. line.price × line.quantity === line.total for every line.
 *
 * Also: RULING T5-c — order creation checks COMBINED demand per component
 * (loose cart items AND every bundle's expansion together), not each
 * bundle independently. Two tests below construct the exact shape that
 * rule forbids missing: two bundles sharing a component, and a bundle plus
 * a loose item of the same product, each jointly exceeding stock.
 *
 * Real Postgres throughout (mirrors tests/integration/loyalty-redemption.test.ts
 * and tests/integration/cart-bundles.test.ts) — `OrderService.create` is
 * called directly, bypassing HTTP, since nothing here needs to assert
 * anything about the route layer. Gated on `hasDb` so this suite skips
 * cleanly when no real database is configured.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { prisma } from '@force/database';
import { CartService } from '@api/services/cart.service';
import { OrderService } from '@api/services/order.service';
import {
  hasDb,
  seedBundleStore,
  seedProduct,
  seedBundle,
  setStock,
  stockOf,
  addItemToCart,
  addBundleToCart,
  checkoutBundleFor,
  groupsOf,
  cartSessionId,
  DEFAULT_TEST_SHIPPING_ADDRESS,
  type FixtureStore,
} from '../helpers/bundle-fixtures';

describe.skipIf(!hasDb)('order creation expands bundles into component lines', () => {
  const suffix = `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  let store: FixtureStore;

  beforeAll(async () => {
    store = await seedBundleStore(suffix);
  });

  /** Seeds the "Ramadan Box" from the design doc's worked example: Dates ×1 (4.500 EGP), Honey ×1 (6.000), Nuts ×2 (2.000 each) — componentSum 14.500, fixed_price 12.000. Returns the three product ids + the bundle id. */
  async function seedRamadanBox(tag: string) {
    const dates = await seedProduct(store.storeId, `${suffix}-${tag}-dates`, {
      price: 4500,
      inventory: 100,
    });
    const honey = await seedProduct(store.storeId, `${suffix}-${tag}-honey`, {
      price: 6000,
      inventory: 100,
    });
    const nuts = await seedProduct(store.storeId, `${suffix}-${tag}-nuts`, {
      price: 2000,
      inventory: 100,
    });
    const ramadanBox = await seedBundle(store.storeId, `${suffix}-${tag}-ramadan`, {
      name: 'Ramadan Box',
      pricingType: 'fixed_price',
      pricingValue: 12000,
      items: [
        { productId: dates, quantity: 1 },
        { productId: honey, quantity: 1 },
        { productId: nuts, quantity: 2 },
      ],
    });
    return { dates, honey, nuts, ramadanBox };
  }

  it('writes one component line per bundle item, sharing a bundleGroupId', async () => {
    const { ramadanBox } = await seedRamadanBox('t1');
    const order = await checkoutBundleFor(store.storeId, ramadanBox, 1);

    const group = order.items.filter(i => i.bundleGroupId);
    expect(group).toHaveLength(3);
    expect(new Set(group.map(i => i.bundleGroupId)).size).toBe(1);
    expect(group.every(i => i.bundleName === 'Ramadan Box')).toBe(true);
    expect(group.every(i => i.bundleId === ramadanBox)).toBe(true);
  });

  it('allocates the bundle price across the lines exactly', async () => {
    const { ramadanBox } = await seedRamadanBox('t2');
    const order = await checkoutBundleFor(store.storeId, ramadanBox, 1);

    const group = order.items.filter(i => i.bundleGroupId);
    // Invariant 1: the group sums to exactly the bundle price in piastres.
    expect(group.reduce((s, i) => s + i.total, 0)).toBe(12000);
    // Invariant 2: unit price × quantity reconciles to the stored total, on
    // EVERY line — this is what makes the allocation representable at all
    // (OrderItem stores both a unit price and a total).
    for (const i of group) {
      expect(i.price * i.quantity).toBe(i.total);
    }
  });

  it('writes one group PER BOX so a single box can be returned', async () => {
    const { ramadanBox } = await seedRamadanBox('t3');
    const order = await checkoutBundleFor(store.storeId, ramadanBox, 2);

    const groups = groupsOf(order);
    expect(groups).toHaveLength(2);
    // Each group is a full, independent box: 3 lines, summing to the
    // per-box price (not the 2-box total).
    for (const g of groups) {
      const lines = order.items.filter(i => i.bundleGroupId === g);
      expect(lines).toHaveLength(3);
      expect(lines.reduce((s, i) => s + i.total, 0)).toBe(12000);
    }
  });

  it('decrements component stock, not any bundle counter', async () => {
    const { honey, ramadanBox } = await seedRamadanBox('t4');
    const before = await stockOf(honey);
    await checkoutBundleFor(store.storeId, ramadanBox, 1);
    expect(await stockOf(honey)).toBe(before - 1);
  });

  it('does not oversell the last box under concurrent checkout', async () => {
    const { honey, ramadanBox } = await seedRamadanBox('t5');
    await setStock(honey, 1); // only 1 honey in stock -> exactly 1 box makeable

    const [a, b] = await Promise.allSettled([
      checkoutBundleFor(store.storeId, ramadanBox, 1),
      checkoutBundleFor(store.storeId, ramadanBox, 1),
    ]);
    const ok = [a, b].filter(r => r.status === 'fulfilled');
    expect(ok).toHaveLength(1);
    expect(await stockOf(honey)).toBe(0);
  });

  // --- Ruling T5-c: combined demand per component, not per-bundle ---

  it('refuses checkout when two different bundles sharing a component would jointly oversell it', async () => {
    const flour = await seedProduct(store.storeId, `${suffix}-t6-flour`, {
      price: 1000,
      inventory: 1, // exactly enough for ONE of the two bundles below, not both
    });
    const onlyInA = await seedProduct(store.storeId, `${suffix}-t6-a`, {
      price: 500,
      inventory: 100,
    });
    const onlyInB = await seedProduct(store.storeId, `${suffix}-t6-b`, {
      price: 700,
      inventory: 100,
    });
    const bundleA = await seedBundle(store.storeId, `${suffix}-t6-bundle-a`, {
      pricingType: 'fixed_price',
      pricingValue: 1200, // componentSum 1500 (1000 + 500)
      items: [
        { productId: flour, quantity: 1 },
        { productId: onlyInA, quantity: 1 },
      ],
    });
    const bundleB = await seedBundle(store.storeId, `${suffix}-t6-bundle-b`, {
      pricingType: 'fixed_price',
      pricingValue: 1400, // componentSum 1700 (1000 + 700)
      items: [
        { productId: flour, quantity: 1 },
        { productId: onlyInB, quantity: 1 },
      ],
    });

    // Each bundle is satisfiable ALONE (flour stock=1 covers either one),
    // but the cart holds BOTH — combined demand for flour is 2, stock is 1.
    const sessionId = cartSessionId('t6');
    await CartService.getOrCreate(store.storeId, sessionId);
    await addBundleToCart(store.storeId, sessionId, bundleA, 1);
    await addBundleToCart(store.storeId, sessionId, bundleB, 1);

    await expect(
      OrderService.create(store.storeId, undefined, sessionId, {
        shippingAddress: DEFAULT_TEST_SHIPPING_ADDRESS,
        paymentMethod: 'myfatoorah',
      })
    ).rejects.toMatchObject({ statusCode: 400 });

    // Refused atomically — nothing decremented, no order written for either bundle.
    expect(await stockOf(flour)).toBe(1);
    const flourOrderItems = await prisma.orderItem.findMany({ where: { productId: flour } });
    expect(flourOrderItems).toHaveLength(0);
  });

  it('refuses checkout when a bundle and a loose item of the same product jointly exceed stock', async () => {
    const sugar = await seedProduct(store.storeId, `${suffix}-t7-sugar`, {
      price: 800,
      inventory: 1, // enough for the bundle's 1 unit alone, not plus a loose unit too
    });
    const filler = await seedProduct(store.storeId, `${suffix}-t7-filler`, {
      price: 300,
      inventory: 100,
    });
    const bundleC = await seedBundle(store.storeId, `${suffix}-t7-bundle`, {
      pricingType: 'fixed_price',
      pricingValue: 900, // componentSum 1100 (800 + 300)
      items: [
        { productId: sugar, quantity: 1 },
        { productId: filler, quantity: 1 },
      ],
    });

    const sessionId = cartSessionId('t7');
    await CartService.getOrCreate(store.storeId, sessionId);
    await addBundleToCart(store.storeId, sessionId, bundleC, 1); // demands 1 sugar
    await addItemToCart(store.storeId, sessionId, sugar, 1); // demands 1 MORE sugar, loose

    await expect(
      OrderService.create(store.storeId, undefined, sessionId, {
        shippingAddress: DEFAULT_TEST_SHIPPING_ADDRESS,
        paymentMethod: 'myfatoorah',
      })
    ).rejects.toMatchObject({ statusCode: 400 });

    expect(await stockOf(sugar)).toBe(1);
  });

  // --- Purchasability re-checked at checkout, not trusted from the cart ---

  it('refuses checkout when a cart bundle became non-purchasable after add-to-cart', async () => {
    const p = await seedProduct(store.storeId, `${suffix}-t8-p`, { price: 400, inventory: 10 });
    const bundleD = await seedBundle(store.storeId, `${suffix}-t8-bundle`, {
      pricingType: 'fixed_price',
      pricingValue: 350,
      items: [{ productId: p, quantity: 1 }],
    });

    const sessionId = cartSessionId('t8');
    await CartService.getOrCreate(store.storeId, sessionId);
    await addBundleToCart(store.storeId, sessionId, bundleD, 1); // purchasable at add-time

    // The bundle is deactivated AFTER it was added to the cart, BEFORE checkout.
    await prisma.bundle.update({ where: { id: bundleD }, data: { isActive: false } });

    await expect(
      OrderService.create(store.storeId, undefined, sessionId, {
        shippingAddress: DEFAULT_TEST_SHIPPING_ADDRESS,
        paymentMethod: 'myfatoorah',
      })
    ).rejects.toMatchObject({ statusCode: 409 });

    // Nothing was decremented or written.
    expect(await stockOf(p)).toBe(10);
    const items = await prisma.orderItem.findMany({ where: { bundleId: bundleD } });
    expect(items).toHaveLength(0);
  });

  // --- Snapshot, not a join ---

  it('bundleName survives a bundle rename after the order was placed', async () => {
    const p = await seedProduct(store.storeId, `${suffix}-t9-p`, { price: 1000, inventory: 10 });
    const bundleId = await seedBundle(store.storeId, `${suffix}-t9-bundle`, {
      name: 'Original Box Name',
      pricingType: 'fixed_price',
      pricingValue: 900,
      items: [{ productId: p, quantity: 1 }],
    });

    const order = await checkoutBundleFor(store.storeId, bundleId, 1);
    expect(order.items.some(i => i.bundleName === 'Original Box Name')).toBe(true);

    // Renamed AFTER the order exists — a six-month-old invoice must still
    // read the name at the time of purchase.
    await prisma.bundle.update({ where: { id: bundleId }, data: { name: 'Renamed Box' } });

    const reread = await prisma.orderItem.findMany({
      where: { orderId: order.id, bundleId },
    });
    expect(reread.length).toBeGreaterThan(0);
    expect(reread.every(i => i.bundleName === 'Original Box Name')).toBe(true);
  });

  // --- Order.bundleDiscount reporting field ---

  it('Order.bundleDiscount equals the independently computed saving', async () => {
    const dates = await seedProduct(store.storeId, `${suffix}-t10-dates`, {
      price: 2000,
      inventory: 100,
    });
    const honey = await seedProduct(store.storeId, `${suffix}-t10-honey`, {
      price: 3000,
      inventory: 100,
    });
    // componentSum 5000, fixed_price 4000 -> 1000 piastres saved per box.
    const bundleId = await seedBundle(store.storeId, `${suffix}-t10-bundle`, {
      pricingType: 'fixed_price',
      pricingValue: 4000,
      items: [
        { productId: dates, quantity: 1 },
        { productId: honey, quantity: 1 },
      ],
    });

    const order = await checkoutBundleFor(store.storeId, bundleId, 2); // 2 boxes
    // Independently computed from the raw seeded fixture values (NOT via
    // resolveBundle, which is the production code path under test):
    // (componentSum - price) * quantity = (5000 - 4000) * 2 = 2000.
    expect(order.bundleDiscount).toBe(2000);
  });

  // --- Blast-radius: payment-failure rollback rebuilds the cart from
  // order.items, which — before bundles — could never have two lines for
  // the same product/variant (CartItem's own uniqueness upstream guaranteed
  // that). A bundle order can (two boxes sharing a component, or a bundle
  // component plus a loose line of the same product), which used to make
  // the rollback's naive one-`create`-per-line loop violate CartItem's
  // partial unique index. See the aggregation fix in
  // `OrderService.rollbackForPaymentFailure`.
  //
  // P1-1 (final review) then corrected the SEMANTICS of that rebuild: the
  // component lines of a box must come back as the BOX (one `CartBundle`),
  // not as loose lines. Restoring them loose re-priced the cart at the
  // shelf-price component sum instead of the bundle price, so a customer
  // whose payment failed on a 12.000 box returned to a 14.500 cart. Only
  // genuinely loose lines aggregate now — see `restoreCartShape`.

  it('payment-failure rollback restores the BOX plus only the genuinely loose lines', async () => {
    const shared = await seedProduct(store.storeId, `${suffix}-t11-shared`, {
      price: 500,
      inventory: 50,
    });
    const filler = await seedProduct(store.storeId, `${suffix}-t11-filler`, {
      price: 300,
      inventory: 50,
    });
    const bundleId = await seedBundle(store.storeId, `${suffix}-t11-bundle`, {
      pricingType: 'fixed_price',
      pricingValue: 700,
      items: [
        { productId: shared, quantity: 1 },
        { productId: filler, quantity: 1 },
      ],
    });

    const sessionId = cartSessionId('t11');
    const order = await checkoutBundleFor(store.storeId, bundleId, 1, {
      sessionId,
      extraItems: [{ productId: shared, quantity: 2 }], // loose line of the SAME product as the bundle component
    });
    // Sanity: two OrderItem rows for `shared` exist (bundle line + loose line).
    const sharedLines = order.items.filter(i => i.productId === shared);
    expect(sharedLines).toHaveLength(2);

    // Must not throw the CartItem partial-unique-index violation.
    await expect(
      OrderService.rollbackForPaymentFailure(store.storeId, order.id, sessionId)
    ).resolves.toBeUndefined();

    const cart = await prisma.cart.findFirst({ where: { storeId: store.storeId, sessionId } });
    const cartItems = await prisma.cartItem.findMany({ where: { cartId: cart!.id } });
    const cartBundles = await prisma.cartBundle.findMany({ where: { cartId: cart!.id } });

    // The box comes back as a box, at the box count that was ordered.
    expect(cartBundles).toHaveLength(1);
    expect(cartBundles[0].bundleId).toBe(bundleId);
    expect(cartBundles[0].quantity).toBe(1);

    // ONE loose row for `shared`, carrying ONLY the loose quantity (2) — the
    // bundle's own component of `shared` lives in the CartBundle above, not
    // here. Restoring it loose as well (quantity 3) is what re-priced the
    // cart at the component sum.
    const sharedCartLines = cartItems.filter(i => i.productId === shared);
    expect(sharedCartLines).toHaveLength(1);
    expect(sharedCartLines[0].quantity).toBe(2);
    // `filler` was ONLY ever a bundle component, so it must not appear loose.
    expect(cartItems.some(i => i.productId === filler)).toBe(false);

    const reread = await prisma.order.findUnique({ where: { id: order.id } });
    expect(reread?.status).toBe('cancelled');
  });

  // --- C1 (final review): order creation must clear cart_bundles, not just
  // cart_items — otherwise a paid box survives in the cart at a live price
  // and a customer whose gateway redirect never lands checks out again,
  // paying twice for the same box. `CartService.clear` (used by the
  // storefront's success page) already deletes both tables and says why;
  // `OrderService.create`'s own transactional clear must do the same
  // WITHOUT going through the web success page, since that page is a
  // client-side best-effort that a lost redirect never reaches.

  it('clears cart_bundles (not just cart_items) when an order is created from a cart containing a bundle', async () => {
    const p = await seedProduct(store.storeId, `${suffix}-c1-p`, { price: 1000, inventory: 10 });
    const bundleId = await seedBundle(store.storeId, `${suffix}-c1-bundle`, {
      pricingType: 'fixed_price',
      pricingValue: 900,
      items: [{ productId: p, quantity: 1 }],
    });

    const sessionId = cartSessionId('c1');
    await checkoutBundleFor(store.storeId, bundleId, 1, { sessionId });

    // Assert directly against the table — NOT via the web success page's
    // client-side clearCart(), which is exactly the path C1 showed cannot
    // be relied on (a lost gateway redirect never reaches it).
    const cart = await prisma.cart.findFirst({ where: { storeId: store.storeId, sessionId } });
    expect(cart).not.toBeNull();
    const remainingBundles = await prisma.cartBundle.findMany({ where: { cartId: cart!.id } });
    expect(remainingBundles).toHaveLength(0);
  });
});
