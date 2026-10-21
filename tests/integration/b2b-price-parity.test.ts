/**
 * Same price everywhere (Review Focus 3), the order-time binding (Ruling B2B-9), MOQ (Review Focus 7), coupon exclusion
 * (Ruling B2B-5) and entitlement staleness (review I2), against a real Postgres through the REAL services:
 * CartService, OrderService.create, OrderService.createAdminOrder and PriceResolver.
 *
 * One fixture, hand-computed numbers (not re-derived by the code under test):
 *   P1 price 10000. Public tier 10+ = 8500. Wholesale group = 10% off.
 *     anonymous : qty1 10000, qty10 8500
 *     wholesaler: qty1  9000 (group %), qty10 8500 (the public tier beats 9000)
 *   P3 price 2000, MOQ 5.   P4 price 1000 (base only).
 * Not driven here (reason in the report): payment-link creation and abandoned-cart recovery totals go through the same
 * `PriceResolver.priceCart` and are pinned by tests/unit/b2b-no-direct-price-reads.test.ts (they must route through it) and
 * the resolver tests; they need a WhatsApp template / a cron sweep to execute end to end.
 * Retry-safe: every fixture keyed on a per-run suffix.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import { prisma } from '@ebda/database';
import { CartService } from '@api/services/cart.service';
import { OrderService } from '@api/services/order.service';
import { PriceResolver } from '@api/services/price-resolver.service';
import { ANONYMOUS_BUYER, type BuyerIdentity } from '@api/lib/buyer-identity';
import {
  hasDb,
  seedBundleStore,
  seedProduct,
  cartSessionId,
  testShippingAddress,
  type FixtureStore,
} from '../helpers/bundle-fixtures';

const session = (userId: string) => ({ kind: 'session', userId }) as unknown as BuyerIdentity;
const merchantShopper = (shopperUserId: string, actorUserId: string) =>
  ({ kind: 'merchant-selected', shopperUserId, actorUserId }) as unknown as BuyerIdentity;

const SUF = `${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
let store: FixtureStore;
const id = {} as Record<string, string>;
const WHOLESALER_PHONE = '+201077770001';

async function cartFor(
  buyer: BuyerIdentity,
  customerId: string | undefined,
  lines: Array<[string, number]>
) {
  const sessionId = cartSessionId(`parity-${SUF}`);
  for (const [productId, qty] of lines) {
    await CartService.addItem(
      store.storeId,
      sessionId,
      productId,
      qty,
      customerId,
      undefined,
      undefined,
      buyer
    );
  }
  return sessionId;
}
const place = (
  sessionId: string,
  buyer: BuyerIdentity,
  extra: Record<string, unknown> = {},
  customerId?: string,
  shipping: Record<string, unknown> = {}
) =>
  OrderService.create(
    store.storeId,
    customerId,
    sessionId,
    {
      shippingAddress: { ...testShippingAddress(), ...shipping },
      paymentMethod: 'paymob',
      ...extra,
    } as never,
    undefined,
    { buyer }
  );

describe.skipIf(!hasDb)('B2B price parity, order-time binding, MOQ, coupon exclusion', () => {
  beforeAll(async () => {
    process.env.OPEN_UNPAID_HOLD_CAP = '1000';
    process.env.OPEN_UNPAID_HOLD_IP_CAP = '1000';
    store = await seedBundleStore(`b2bpar-${SUF}`);
    const sid = store.storeId;
    id.p1 = await seedProduct(sid, `p1-${SUF}`, {
      price: 10_000,
      inventory: 10_000,
      trackInventory: false,
    });
    id.p3 = await seedProduct(sid, `p3-${SUF}`, {
      price: 2_000,
      inventory: 10_000,
      trackInventory: false,
    });
    id.p4 = await seedProduct(sid, `p4-${SUF}`, {
      price: 1_000,
      inventory: 10_000,
      trackInventory: false,
    });
    await prisma.product.update({ where: { id: id.p3 }, data: { moq: 5 } });
    const group = await prisma.customerGroup.create({
      data: {
        storeId: sid,
        name: 'Wholesale',
        pricingMode: 'percent_off',
        discountBps: 1_000,
        isWholesale: true,
      },
    });
    id.group = group.id;
    await prisma.productPriceTier.create({
      data: { storeId: sid, productId: id.p1, minQty: 10, priceMinor: 8_500 },
    });
    const w = await prisma.user.create({
      data: {
        email: `b2bpar-w-${SUF}@test.com`,
        passwordHash: 'x',
        firstName: 'W',
        lastName: 'H',
        role: 'customer',
        emailVerified: true,
        storeId: sid,
        phone: WHOLESALER_PHONE,
      },
    });
    id.w = w.id;
    await prisma.customer.create({
      data: {
        storeId: sid,
        email: w.email,
        phone: WHOLESALER_PHONE,
        firstName: 'W',
        lastName: 'H',
        groupId: group.id,
        userId: w.id,
      },
    });
    await prisma.storeFeature.create({
      data: { storeId: sid, featureKey: 'b2b.wholesale', enabled: true },
    });
  });

  afterAll(async () => {
    delete process.env.OPEN_UNPAID_HOLD_CAP;
    delete process.env.OPEN_UNPAID_HOLD_IP_CAP;
    if (!store) return;
    const sid = store.storeId;
    await prisma.orderEvent.deleteMany({ where: { storeId: sid } });
    await prisma.orderItem.deleteMany({ where: { order: { storeId: sid } } });
    await prisma.order.deleteMany({ where: { storeId: sid } });
    await prisma.cartItem.deleteMany({ where: { cart: { storeId: sid } } });
    await prisma.cart.deleteMany({ where: { storeId: sid } });
    await prisma.storeFeature.deleteMany({ where: { storeId: sid } });
    await prisma.storeSubscription.deleteMany({ where: { storeId: sid } });
  });

  it('the cart shows the resolved unit price per line, per buyer, and re-prices when the quantity changes (RF4)', async () => {
    const sessionId = cartSessionId(`cart-${SUF}`);
    let cart = await CartService.addItem(
      store.storeId,
      sessionId,
      id.p1,
      1,
      id.w,
      undefined,
      undefined,
      session(id.w)
    );
    const line = () =>
      cart.items.find(i => i.productId === id.p1)! as {
        id: string;
        unitPrice: number;
        lineTotal: number;
        priceSource: string;
      };
    expect(line().unitPrice).toBe(9_000);
    expect(line().priceSource).toBe('group');
    cart = await CartService.updateItem(
      store.storeId,
      sessionId,
      line().id,
      10,
      id.w,
      session(id.w)
    );
    expect(line().unitPrice).toBe(8_500);
    expect(line().priceSource).toBe('tier');
    expect(line().lineTotal).toBe(85_000);
    expect(cart.subtotal).toBe(85_000);
    cart = await CartService.updateItem(
      store.storeId,
      sessionId,
      line().id,
      9,
      id.w,
      session(id.w)
    );
    expect(line().unitPrice).toBe(9_000); // 10 -> 9 reverts to the group price
    // the same cart session read anonymously is retail (a quote per buyer, never stored)
    const anon = await CartService.getOrCreate(
      store.storeId,
      sessionId,
      undefined,
      ANONYMOUS_BUYER
    );
    expect((anon.items.find(i => i.productId === id.p1)! as { unitPrice: number }).unitPrice).toBe(
      10_000
    );
  });

  it('PARITY: cart read, PriceResolver, checkout and admin order charge the identical unit price (wholesaler qty 1 and 10)', async () => {
    for (const [qty, expected] of [
      [1, 9_000],
      [10, 8_500],
    ] as const) {
      const sessionId = await cartFor(session(id.w), undefined, [[id.p1, qty]]);
      const cart = await CartService.getOrCreate(
        store.storeId,
        sessionId,
        undefined,
        session(id.w)
      );
      const cartUnit = (cart.items[0] as { unitPrice: number }).unitPrice;

      const resolver = await PriceResolver.forBuyer(store.storeId, session(id.w));
      const direct = (await resolver.priceLine({ id: id.p1, price: 10_000 }, null, qty)).unitMinor;

      const order = await place(sessionId, session(id.w), {}, id.w);
      const orderLine = order.items[0]!;

      const admin = await OrderService.createAdminOrder(
        store.storeId,
        store.ownerId,
        {
          customerId: id.w,
          shippingAddress: { ...testShippingAddress() },
          items: [{ productId: id.p1, quantity: qty }],
        },
        { role: 'store_admin' },
        { buyer: merchantShopper(id.w, store.ownerId) }
      );
      const adminLine = admin.items[0]!;

      expect([cartUnit, direct, orderLine.price, adminLine.price], `qty ${qty}`).toEqual([
        expected,
        expected,
        expected,
        expected,
      ]);
      expect(orderLine.total).toBe(expected * qty);
      expect(adminLine.total).toBe(expected * qty);
    }
  });

  it('persists the price provenance snapshot on the line and the group name on the order', async () => {
    const sessionId = await cartFor(session(id.w), undefined, [[id.p1, 1]]);
    const order = await place(sessionId, session(id.w), {}, id.w);
    expect(order.items[0]).toMatchObject({
      price: 9_000,
      listPrice: 10_000,
      priceSource: 'group',
      priceTierMinQty: null,
      priceGroupApplied: true,
    });
    const full = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(full.priceGroupName).toBe('Wholesale');

    const tierSession = await cartFor(ANONYMOUS_BUYER, undefined, [[id.p1, 10]]);
    const tierOrder = await place(tierSession, ANONYMOUS_BUYER);
    expect(tierOrder.items[0]).toMatchObject({
      price: 8_500,
      listPrice: 10_000,
      priceSource: 'tier',
      priceTierMinQty: 10,
      priceGroupApplied: false, // a public break: labelled "Quantity price" (final review minor 4)
    });
    // the entitlement snapshot a later partial return reads (Rulings B2B-17 / B2B-18)
    expect(tierOrder.items[0]!.tierLadder).toMatchObject({
      rungs: expect.arrayContaining([
        { minQty: 10, priceMinor: 8_500, variant: false, group: false },
      ]),
      groupPercentMinor: null,
    });
    expect(
      (await prisma.order.findUniqueOrThrow({ where: { id: tierOrder.id } })).priceGroupName
    ).toBeNull();
  });

  it("RF2: a guest checkout whose typed phone / email is the wholesaler's is charged RETAIL", async () => {
    const sessionId = await cartFor(ANONYMOUS_BUYER, undefined, [[id.p1, 1]]);
    const order = await place(sessionId, ANONYMOUS_BUYER, {}, undefined, {
      phone: WHOLESALER_PHONE,
      email: `b2bpar-w-${SUF}@test.com`,
    });
    expect(order.items[0]).toMatchObject({ price: 10_000, priceSource: 'base' });
  });

  it("RF2 (admin): an admin order with the wholesaler's phone typed but NO customer selected is retail; selecting the shopper prices as the group", async () => {
    const typed = await OrderService.createAdminOrder(
      store.storeId,
      store.ownerId,
      {
        shippingAddress: { ...testShippingAddress(), phone: WHOLESALER_PHONE },
        items: [{ productId: id.p1, quantity: 1 }],
      },
      { role: 'store_admin' },
      { buyer: ANONYMOUS_BUYER }
    );
    expect(typed.items[0]!.price).toBe(10_000);
    const picked = await OrderService.createAdminOrder(
      store.storeId,
      store.ownerId,
      {
        customerId: id.w,
        shippingAddress: { ...testShippingAddress() },
        items: [{ productId: id.p1, quantity: 1 }],
      },
      { role: 'store_admin' },
      { buyer: merchantShopper(id.w, store.ownerId) }
    );
    expect(picked.items[0]!.price).toBe(9_000);
  });

  it('B2B-9: a stale expectedTotal is 409 PRICE_CHANGED with the new lines, nothing is created, and a tier edit between cart and order is caught', async () => {
    const sessionId = await cartFor(ANONYMOUS_BUYER, undefined, [[id.p1, 10]]);
    const before = await prisma.order.count({ where: { storeId: store.storeId } });
    const shipping = { ...testShippingAddress() };
    const probe = await OrderService.create(
      store.storeId,
      undefined,
      sessionId,
      { shippingAddress: shipping, paymentMethod: 'paymob', expectedTotal: 1 } as never,
      undefined,
      { buyer: ANONYMOUS_BUYER }
    ).catch(e => e);
    expect(probe).toMatchObject({ statusCode: 409, code: 'PRICE_CHANGED' });
    expect(probe.details.lines[0]).toMatchObject({ unitPrice: 8_500, priceSource: 'tier' });
    const seenTotal = probe.details.total as number;
    expect(await prisma.order.count({ where: { storeId: store.storeId } })).toBe(before);

    // the merchant lowers the tier after the shopper saw `seenTotal`
    await prisma.productPriceTier.updateMany({
      where: { productId: id.p1, groupId: null },
      data: { priceMinor: 8_000 },
    });
    try {
      const stale = await OrderService.create(
        store.storeId,
        undefined,
        sessionId,
        { shippingAddress: shipping, paymentMethod: 'paymob', expectedTotal: seenTotal } as never,
        undefined,
        { buyer: ANONYMOUS_BUYER }
      ).catch(e => e);
      expect(stale).toMatchObject({ statusCode: 409, code: 'PRICE_CHANGED' });
      // confirming the NEW total goes through at the new price
      const ok = await OrderService.create(
        store.storeId,
        undefined,
        sessionId,
        {
          shippingAddress: shipping,
          paymentMethod: 'paymob',
          expectedTotal: stale.details.total,
        } as never,
        undefined,
        { buyer: ANONYMOUS_BUYER }
      );
      expect(ok.items[0]!.price).toBe(8_000);
    } finally {
      await prisma.productPriceTier.updateMany({
        where: { productId: id.p1, groupId: null },
        data: { priceMinor: 8_500 },
      });
    }
  });

  it('RF7: below MOQ the cart may be built, but the order is 422 BELOW_MOQ listing ALL offending products; at MOQ it passes', async () => {
    await prisma.product.update({ where: { id: id.p4 }, data: { moq: 3 } });
    try {
      const sessionId = await cartFor(ANONYMOUS_BUYER, undefined, [
        [id.p3, 2],
        [id.p4, 1],
      ]);
      const cart = await CartService.getOrCreate(
        store.storeId,
        sessionId,
        undefined,
        ANONYMOUS_BUYER
      );
      expect(cart.items.map(i => (i as { belowMoq: boolean }).belowMoq)).toEqual([true, true]); // cart allowed, flagged
      const err = await place(sessionId, ANONYMOUS_BUYER).catch(e => e);
      expect(err).toMatchObject({ statusCode: 422, code: 'BELOW_MOQ' });
      expect(
        err.details.lines
          .map((l: { productId: string; required: number; current: number }) => [
            l.productId,
            l.required,
            l.current,
          ])
          .sort()
      ).toEqual(
        [
          [id.p3, 5, 2],
          [id.p4, 3, 1],
        ].sort()
      );
      const okSession = await cartFor(ANONYMOUS_BUYER, undefined, [
        [id.p3, 5],
        [id.p4, 3],
      ]);
      const order = await place(okSession, ANONYMOUS_BUYER);
      expect(order.items.map(i => i.quantity).sort()).toEqual([3, 5]);
    } finally {
      await prisma.product.update({ where: { id: id.p4 }, data: { moq: null } });
    }
  });

  it('RF7 (admin): BELOW_MOQ unless overrideMoq; staff cannot override; store_admin needs a reason and leaves an order event', async () => {
    const data = {
      shippingAddress: { ...testShippingAddress() },
      items: [{ productId: id.p3, quantity: 1 }],
    };
    const call = (d: Record<string, unknown>, role: string) =>
      OrderService.createAdminOrder(
        store.storeId,
        store.ownerId,
        d as never,
        { role },
        { buyer: ANONYMOUS_BUYER }
      );
    await expect(call(data, 'store_admin')).rejects.toMatchObject({
      statusCode: 422,
      code: 'BELOW_MOQ',
    });
    await expect(
      call({ ...data, overrideMoq: true, moqOverrideReason: 'phone order agreed' }, 'staff')
    ).rejects.toMatchObject({ statusCode: 403, code: 'MOQ_OVERRIDE_FORBIDDEN' });
    await expect(call({ ...data, overrideMoq: true }, 'store_admin')).rejects.toMatchObject({
      code: 'MOQ_OVERRIDE_REASON_REQUIRED',
    });
    const order = await call(
      { ...data, overrideMoq: true, moqOverrideReason: 'phone order agreed' },
      'store_admin'
    );
    const ev = await prisma.orderEvent.findFirst({
      where: { orderId: order.id, toStatus: 'moq_override' },
    });
    expect(ev?.actorId).toBe(store.ownerId);
    expect(ev?.metadata).toMatchObject({ reason: 'phone order agreed' });
  });

  it('B2B-5: a coupon never discounts a tier / group priced line, only the base-priced ones', async () => {
    const coupon = await prisma.coupon.create({
      data: {
        storeId: store.storeId,
        code: `B2B10-${SUF}`.toUpperCase(),
        name: 'ten',
        type: 'percentage',
        value: 10,
      },
    });
    // P1 x10 = 85000 (tier, excluded) ; P4 x3 = 3000 (base, eligible) -> 10% of 3000 = 300, not 10% of 88000
    const sessionId = await cartFor(ANONYMOUS_BUYER, undefined, [
      [id.p1, 10],
      [id.p4, 3],
    ]);
    const order = await place(sessionId, ANONYMOUS_BUYER, { couponCode: coupon.code });
    expect(order.subtotal).toBe(88_000);
    expect(order.discount).toBe(300);
    // with only the tier line the coupon has nothing to discount
    const tierOnly = await cartFor(ANONYMOUS_BUYER, undefined, [[id.p1, 10]]);
    const o2 = await place(tierOnly, ANONYMOUS_BUYER, { couponCode: coupon.code });
    expect(o2.discount).toBe(0); // 85000 of tier-priced goods: the coupon has no eligible line to discount
    expect(o2.subtotal).toBe(85_000);
  });

  it("B2B-M2 (final review P2-3): a free-shipping code's minimum is judged on the whole loose cart, so an all-tier cart qualifies; a percentage code's minimum still is not", async () => {
    const mk = (code: string, type: 'free_shipping' | 'percentage') =>
      prisma.coupon.create({
        data: {
          storeId: store.storeId,
          code: `${code}-${SUF}`.toUpperCase(),
          name: code,
          type,
          value: type === 'percentage' ? 10 : 0,
          minOrderAmount: 50_000,
        },
      });
    const ship = await mk('FS500', 'free_shipping');
    const pct = await mk('PCT500', 'percentage');
    // 85000 of tier-priced goods, base basis 0: "free shipping over 500" applies (was 400 MIN_ORDER_NOT_MET)
    const o = await place(
      await cartFor(ANONYMOUS_BUYER, undefined, [[id.p1, 10]]),
      ANONYMOUS_BUYER,
      {
        couponCode: ship.code,
      }
    );
    expect(o).toMatchObject({ subtotal: 85_000, shipping: 0, discount: 0, couponCode: ship.code });
    // the B2B-5 basis still governs a percentage code
    await expect(
      place(await cartFor(ANONYMOUS_BUYER, undefined, [[id.p1, 10]]), ANONYMOUS_BUYER, {
        couponCode: pct.code,
      })
    ).rejects.toMatchObject({ code: 'MIN_ORDER_NOT_MET' });
    // admin order: same split
    const admin = await OrderService.createAdminOrder(
      store.storeId,
      store.ownerId,
      {
        shippingAddress: { ...testShippingAddress() },
        items: [{ productId: id.p1, quantity: 10 }],
        couponCode: ship.code,
      },
      { role: 'store_admin' },
      { buyer: ANONYMOUS_BUYER }
    );
    expect(admin).toMatchObject({ shipping: 0, couponCode: ship.code });
    await expect(
      OrderService.createAdminOrder(
        store.storeId,
        store.ownerId,
        {
          shippingAddress: { ...testShippingAddress() },
          items: [{ productId: id.p1, quantity: 10 }],
          couponCode: pct.code,
        },
        { role: 'store_admin' },
        { buyer: ANONYMOUS_BUYER }
      )
    ).rejects.toMatchObject({ code: 'MIN_ORDER_NOT_MET' });
  });

  it('I2: the entitlement is read UNCACHED at order time - a plan/override change binds the very next order', async () => {
    const sessionId = () => cartFor(session(id.w), undefined, [[id.p1, 1]]);
    // override OFF -> retail even though the group and tiers exist
    await prisma.storeFeature.updateMany({
      where: { storeId: store.storeId, featureKey: 'b2b.wholesale' },
      data: { enabled: false },
    });
    expect((await place(await sessionId(), session(id.w), {}, id.w)).items[0]!.price).toBe(10_000);
    // no override, plan = business (written by migration 0200) -> wholesale
    await prisma.storeFeature.deleteMany({
      where: { storeId: store.storeId, featureKey: 'b2b.wholesale' },
    });
    await prisma.storeSubscription.create({
      data: { storeId: store.storeId, planCode: 'business', status: 'active' },
    });
    expect((await place(await sessionId(), session(id.w), {}, id.w)).items[0]!.price).toBe(9_000);
    // downgrade to basic -> retail immediately
    await prisma.storeSubscription.update({
      where: { storeId: store.storeId },
      data: { planCode: 'basic' },
    });
    expect((await place(await sessionId(), session(id.w), {}, id.w)).items[0]!.price).toBe(10_000);
    // restore for later tests
    await prisma.storeSubscription.deleteMany({ where: { storeId: store.storeId } });
    await prisma.storeFeature.create({
      data: { storeId: store.storeId, featureKey: 'b2b.wholesale', enabled: true },
    });
  });

  it('RF5: integer rounding holds across lines - price x quantity === total and the line totals sum to the subtotal', async () => {
    const odd = await seedProduct(store.storeId, `odd-${SUF}`, {
      price: 9_999,
      inventory: 10_000,
      trackInventory: false,
    });
    await prisma.customerGroup.update({ where: { id: id.group }, data: { discountBps: 1_250 } });
    try {
      const sessionId = await cartFor(session(id.w), undefined, [
        [odd, 7],
        [id.p4, 3],
        [id.p3, 5],
      ]);
      const order = await place(sessionId, session(id.w), {}, id.w);
      for (const l of order.items) expect(l.price * l.quantity).toBe(l.total);
      expect(order.items.reduce((s, l) => s + l.total, 0)).toBe(order.subtotal);
      expect(order.items.find(l => l.productId === odd)!.price).toBe(8_749); // 12.5% off 9999 = 8749.125
    } finally {
      await prisma.customerGroup.update({ where: { id: id.group }, data: { discountBps: 1_000 } });
    }
  });

  it('RF11: a persisted line keeps its wholesale price after the group is revoked (refunds read the line, never re-resolve)', async () => {
    const sessionId = await cartFor(session(id.w), undefined, [[id.p1, 1]]);
    const order = await place(sessionId, session(id.w), {}, id.w);
    await prisma.customer.updateMany({
      where: { storeId: store.storeId, userId: id.w },
      data: { groupId: null },
    });
    try {
      const again = await prisma.orderItem.findFirstOrThrow({ where: { orderId: order.id } });
      expect(again.price).toBe(9_000);
    } finally {
      await prisma.customer.updateMany({
        where: { storeId: store.storeId, userId: id.w },
        data: { groupId: id.group },
      });
    }
  });

  it('I-1: the quote is the exact total the order will charge, for the wholesaler and for a guest, with every figure equal', async () => {
    for (const [buyer, userId, expectUnit] of [
      [session(id.w), id.w, 8_500],
      [ANONYMOUS_BUYER, undefined, 8_500],
    ] as const) {
      const sessionId = await cartFor(buyer, undefined, [
        [id.p1, 10],
        [id.p4, 3],
      ]);
      const data = { shippingAddress: { ...testShippingAddress() }, paymentMethod: 'cod' } as never;
      const quote = await OrderService.quote(store.storeId, userId, sessionId, data, buyer);
      expect(quote.lines.find(l => l.productId === id.p1)!.unitPrice).toBe(expectUnit);
      const order = await OrderService.create(
        store.storeId,
        userId,
        sessionId,
        { ...(data as object), expectedTotal: quote.total } as never,
        undefined,
        { buyer }
      );
      expect([order.total, order.subtotal, order.discount, order.shipping]).toEqual([
        quote.total,
        quote.subtotal,
        quote.discount,
        quote.shipping,
      ]);
    }
  });

  it('I-1: approval revoked BETWEEN quote and order -> 409 PRICE_CHANGED carrying the new total; the buyer confirms the new total and is charged retail', async () => {
    const sessionId = await cartFor(session(id.w), undefined, [[id.p1, 1]]);
    const data = { shippingAddress: { ...testShippingAddress() }, paymentMethod: 'paymob' };
    const quote = await OrderService.quote(
      store.storeId,
      undefined,
      sessionId,
      data as never,
      session(id.w)
    );
    expect(quote.lines[0]!.unitPrice).toBe(9_000); // what the buyer saw and confirmed
    await prisma.customer.updateMany({
      where: { storeId: store.storeId, userId: id.w },
      data: { groupId: null },
    });
    try {
      const before = await prisma.order.count({ where: { storeId: store.storeId } });
      const refused = await OrderService.create(
        store.storeId,
        id.w,
        sessionId,
        { ...data, expectedTotal: quote.total } as never,
        undefined,
        { buyer: session(id.w) }
      ).catch(e => e);
      expect(refused).toMatchObject({ statusCode: 409, code: 'PRICE_CHANGED' });
      expect(refused.details.total).toBeGreaterThan(quote.total); // retail is dearer
      expect(refused.details.lines[0]).toMatchObject({ unitPrice: 10_000, priceSource: 'base' });
      expect(await prisma.order.count({ where: { storeId: store.storeId } })).toBe(before); // nothing charged
      // the buyer sees the new total (a fresh quote equals it) and confirms it
      const fresh = await OrderService.quote(
        store.storeId,
        undefined,
        sessionId,
        data as never,
        session(id.w)
      );
      expect(fresh.total).toBe(refused.details.total);
      const ok = await OrderService.create(
        store.storeId,
        id.w,
        sessionId,
        { ...data, expectedTotal: fresh.total } as never,
        undefined,
        { buyer: session(id.w) }
      );
      expect(ok.items[0]!.price).toBe(10_000);
    } finally {
      await prisma.customer.updateMany({
        where: { storeId: store.storeId, userId: id.w },
        data: { groupId: id.group },
      });
    }
  });

  it('M-3: loyalty points cannot be redeemed against tier / group priced lines (same exclusion as coupons)', async () => {
    await prisma.store.update({ where: { id: store.storeId }, data: { loyaltyEnabled: true } });
    await prisma.storeFeature.upsert({
      where: { storeId_featureKey: { storeId: store.storeId, featureKey: 'loyalty' } },
      update: { enabled: true },
      create: { storeId: store.storeId, featureKey: 'loyalty', enabled: true },
    });
    await prisma.loyaltyPoints.upsert({
      where: { storeId_customerId: { storeId: store.storeId, customerId: id.w } },
      update: { points: 1_000_000 },
      create: { storeId: store.storeId, customerId: id.w, points: 1_000_000 },
    });
    const data = {
      shippingAddress: { ...testShippingAddress() },
      paymentMethod: 'paymob',
      pointsToRedeem: 1_000_000,
    } as never;
    // all tier / group priced: nothing to redeem against
    const tierCart = await cartFor(session(id.w), undefined, [[id.p1, 10]]);
    expect(
      (await OrderService.quote(store.storeId, id.w, tierCart, data, session(id.w))).discount
    ).toBe(0);
    // mixed: with the group % off, P4 is base-priced and P1 x10 is the public tier. Only the base-priced 3 x 1000 line can
    // absorb points, never the 85000 tier line.
    await prisma.customerGroup.update({ where: { id: id.group }, data: { pricingMode: 'none' } });
    try {
      const mixed = await cartFor(session(id.w), undefined, [
        [id.p1, 10],
        [id.p4, 3],
      ]);
      const q = await OrderService.quote(store.storeId, id.w, mixed, data, session(id.w));
      expect(q.subtotal).toBe(88_000);
      // the store default caps redemption at 50% of the redeemable goods: 50% of 3000, not 50% of 88000
      expect(q.discount).toBe(1_500);
    } finally {
      await prisma.customerGroup.update({
        where: { id: id.group },
        data: { pricingMode: 'percent_off' },
      });
    }
  });

  it('M-5: an admin order for a suspended or deleted shopper is refused (409 CUSTOMER_INACTIVE), and the price loader also ignores such an account', async () => {
    const dead = await prisma.user.create({
      data: {
        email: `b2bpar-dead-${SUF}@test.com`,
        passwordHash: 'x',
        firstName: 'D',
        lastName: 'D',
        role: 'customer',
        emailVerified: true,
        storeId: store.storeId,
        status: 'suspended',
      },
    });
    await prisma.customer.create({
      data: {
        storeId: store.storeId,
        email: dead.email,
        firstName: 'D',
        lastName: 'D',
        groupId: id.group,
        userId: dead.id,
      },
    });
    const adminData = {
      customerId: dead.id,
      shippingAddress: { ...testShippingAddress() },
      items: [{ productId: id.p1, quantity: 1 }],
    };
    await expect(
      OrderService.createAdminOrder(
        store.storeId,
        store.ownerId,
        adminData as never,
        { role: 'store_admin' },
        { buyer: merchantShopper(dead.id, store.ownerId) }
      )
    ).rejects.toMatchObject({ statusCode: 409, code: 'CUSTOMER_INACTIVE' });
    const r = await PriceResolver.forBuyer(store.storeId, merchantShopper(dead.id, store.ownerId));
    expect((await r.priceLine({ id: id.p1, price: 10_000 }, null, 1)).source).toBe('base');
    await prisma.user.update({
      where: { id: dead.id },
      data: { status: 'active', deletedAt: new Date() },
    });
    await expect(
      OrderService.createAdminOrder(
        store.storeId,
        store.ownerId,
        adminData as never,
        { role: 'store_admin' },
        { buyer: merchantShopper(dead.id, store.ownerId) }
      )
    ).rejects.toMatchObject({ code: 'CUSTOMER_INACTIVE' });
  });
});
