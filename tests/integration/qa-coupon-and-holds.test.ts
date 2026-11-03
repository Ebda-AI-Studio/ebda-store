/**
 * QA 2026-11-03, Postgres path (the Durable Object twin is in packages/repo/test/do-order-ops.test.ts).
 *  - QA-COUPON-1: a storefront-shaped COD order with a coupon is charged EXACTLY the quoted total; an order that arrives
 *    without the coupon the buyer saw is refused (409 PRICE_CHANGED), never silently charged more; a 0-value coupon is
 *    refused at quote and at order, not "accepted".
 *  - QA-HOLDS-1: eight COD orders from one IP with different phones are all accepted; one phone is still capped.
 * Real services against a real Postgres. Retry-safe: every fixture keyed on a per-run suffix, sessions from cartSessionId().
 */
import { describe, it, expect, beforeAll } from 'vitest';
import crypto from 'node:crypto';
import { prisma } from '@ebda/database';
import { CartService } from '@api/services/cart.service';
import { OrderService } from '@api/services/order.service';
import { ANONYMOUS_BUYER } from '@api/lib/buyer-identity';
import {
  hasDb,
  seedBundleStore,
  seedProduct,
  cartSessionId,
  testShippingAddress,
  type FixtureStore,
} from '../helpers/bundle-fixtures';

const SUF = `${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
let store: FixtureStore;
let productId: string;

async function cart(label: string, qty = 1) {
  const sessionId = cartSessionId(`qa-${label}-${SUF}`);
  await CartService.addItem(
    store.storeId,
    sessionId,
    productId,
    qty,
    undefined,
    undefined,
    undefined,
    ANONYMOUS_BUYER
  );
  return sessionId;
}
/** The body the storefront sends (CheckoutClient.handleSubmit): COD, coupon code, expectedTotal. */
const body = (over: Record<string, unknown> = {}) =>
  ({
    shippingAddress: { ...testShippingAddress(), phone: '+201012345678' },
    paymentMethod: 'cod',
    locale: 'ar',
    smsOptIn: false,
    ...over,
  }) as never;

describe.skipIf(!hasDb)('QA-COUPON-1 / QA-HOLDS-1 (Postgres path)', () => {
  beforeAll(async () => {
    store = await seedBundleStore(`qa-coupon-${SUF}`);
    productId = await seedProduct(store.storeId, `shirt-${SUF}`, {
      price: 45_000,
      inventory: 10_000,
      trackInventory: false,
    });
    await prisma.coupon.create({
      data: {
        storeId: store.storeId,
        code: `QA20${SUF}`.toUpperCase(),
        name: 'QA 20',
        type: 'percentage',
        value: 20,
        minOrderAmount: 20_000,
        maxDiscount: 30_000,
      },
    });
    await prisma.coupon.create({
      data: {
        storeId: store.storeId,
        code: `ZERO${SUF}`.toUpperCase(),
        name: 'zero',
        type: 'percentage',
        value: 0,
      },
    });
  });
  const code = () => `QA20${SUF}`.toUpperCase();

  it('charges exactly the quoted total, and a coupon the buyer saw cannot be dropped', async () => {
    const quoted = await OrderService.quote(
      store.storeId,
      undefined,
      await cart('a'),
      body({ couponCode: code() }),
      ANONYMOUS_BUYER
    );
    expect(quoted.discount).toBe(9_000);

    const sessionId = await cart('b');
    const order = await OrderService.create(
      store.storeId,
      undefined,
      sessionId,
      body({ couponCode: code(), expectedTotal: quoted.total }),
      undefined,
      { buyer: ANONYMOUS_BUYER, checkoutIp: '41.0.0.1' }
    );
    expect(order.total).toBe(quoted.total);
    expect(order.couponCode).toBe(code());

    // the dropped-coupon failure: the buyer saw quoted.total, the request carries no coupon
    const dropped = await cart('c');
    await expect(
      OrderService.create(
        store.storeId,
        undefined,
        dropped,
        body({ expectedTotal: quoted.total }),
        undefined,
        { buyer: ANONYMOUS_BUYER, checkoutIp: '41.0.0.2' }
      )
    ).rejects.toMatchObject({ statusCode: 409, code: 'PRICE_CHANGED' });
  });

  it('refuses a 0-value coupon at quote and at order', async () => {
    const zero = `ZERO${SUF}`.toUpperCase();
    await expect(
      OrderService.quote(
        store.storeId,
        undefined,
        await cart('z1'),
        body({ couponCode: zero }),
        ANONYMOUS_BUYER
      )
    ).rejects.toMatchObject({ code: 'INVALID_COUPON' });
    await expect(
      OrderService.create(
        store.storeId,
        undefined,
        await cart('z2'),
        body({ couponCode: zero }),
        undefined,
        { buyer: ANONYMOUS_BUYER }
      )
    ).rejects.toMatchObject({ code: 'INVALID_COUPON' });
  });

  it('QA-HOLDS-1: eight COD orders from one IP, eight phones: all accepted; the same phone is still capped at 2', async () => {
    for (let i = 0; i < 8; i++) {
      await OrderService.create(
        store.storeId,
        undefined,
        await cart(`h${i}`),
        body({ shippingAddress: { ...testShippingAddress(), phone: `+2010123000${i}${i}` } }),
        undefined,
        { buyer: ANONYMOUS_BUYER, checkoutIp: '41.99.99.99' }
      );
    }
    const phone = '+201055500000';
    for (let i = 0; i < 2; i++) {
      await OrderService.create(
        store.storeId,
        undefined,
        await cart(`p${i}`),
        body({ shippingAddress: { ...testShippingAddress(), phone } }),
        undefined,
        { buyer: ANONYMOUS_BUYER, checkoutIp: `41.88.0.${i}` }
      );
    }
    await expect(
      OrderService.create(
        store.storeId,
        undefined,
        await cart('p3'),
        body({ shippingAddress: { ...testShippingAddress(), phone } }),
        undefined,
        { buyer: ANONYMOUS_BUYER, checkoutIp: '41.88.0.9' }
      )
    ).rejects.toMatchObject({ statusCode: 429, code: 'TOO_MANY_OPEN_HOLDS' });
  });
});
