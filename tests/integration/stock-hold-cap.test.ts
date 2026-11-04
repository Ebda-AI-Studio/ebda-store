/**
 * Stock-hold abuse fix, end to end against a real Postgres.
 *
 * `OrderService.create` reserves stock atomically for EVERY payment method,
 * including guest checkout (no account required). Two exploit shapes shared
 * the same root cause — no cap on how many open unpaid holds the same
 * phone/email/IP can accumulate:
 *
 *   - COD is deliberately excluded from the 2-day auto-cancel sweep (ruling
 *     MONEYB-7), so a COD hold on low-stock inventory could sit open forever
 *     with zero payment and zero verification.
 *   - InstaPay sets its own confirmation window with no check against the
 *     caller's OTHER open holds before accepting a new one.
 *
 * `lib/stock-hold-cap.ts` checks inside the stock-reserving money transaction,
 * after acquiring sorted tenant identity locks. Phone/email default to two
 * open unpaid holds; IP independently defaults to eight, even with contacts.
 * Fully wallet-paid orders are exempt, and rejected partial-wallet holds
 * never debit the wallet. Any other method label (gateway, or an invented one) is
 * counted against a looser cap (default 5, ruling S4-1); manual payment
 * attachment requires the server-owned admission marker.
 *
 * Same fixtures + "real Postgres, no DB bypass" convention as
 * `tests/integration/soft-deleted-product-checkout-block.test.ts`.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { prisma } from '@ebda/database';
import { AppError } from '@api/middleware/error-handler';
import { OrderService } from '@api/services/order.service';
import {
  hasDb,
  seedBundleStore,
  seedProduct,
  cartSessionId,
  addItemToCart,
  DEFAULT_TEST_SHIPPING_ADDRESS,
  type FixtureStore,
} from '../helpers/bundle-fixtures';

/** Places one order for `storeId` from a FRESH cart/session, overriding shippingAddress fields and/or the checkout IP — the exact shape `OrderService.create`'s callers (public/order routes) pass. */
async function placeOrder(
  storeId: string,
  productId: string,
  opts: {
    paymentMethod: string;
    phone?: string | null;
    email?: string | null;
    ip?: string;
  }
) {
  const sessionId = cartSessionId(`stock-hold-cap-${Math.random().toString(36).slice(2, 8)}`);
  await addItemToCart(storeId, sessionId, productId, 1);
  const { phone, email, ...rest } = opts;
  const shippingAddress: Record<string, unknown> = { ...DEFAULT_TEST_SHIPPING_ADDRESS };
  if ('phone' in opts) {
    if (phone == null) delete shippingAddress.phone;
    else shippingAddress.phone = phone;
  }
  if ('email' in opts) {
    if (email == null) delete shippingAddress.email;
    else shippingAddress.email = email;
  }
  return OrderService.create(
    storeId,
    undefined,
    sessionId,
    {
      shippingAddress: shippingAddress as typeof DEFAULT_TEST_SHIPPING_ADDRESS,
      paymentMethod: rest.paymentMethod,
    },
    undefined,
    rest.ip ? { checkoutIp: rest.ip } : undefined
  );
}

describe.skipIf(!hasDb)('stock-hold abuse fix (open unpaid order cap)', () => {
  afterEach(() => {
    delete process.env.OPEN_UNPAID_HOLD_CAP;
    delete process.env.OPEN_UNPAID_HOLD_IP_CAP;
  });

  async function setUp(suffix: string) {
    const store: FixtureStore = await seedBundleStore(suffix);
    const productId = await seedProduct(store.storeId, `${suffix}-hold-cap`, {
      inventory: 100,
      price: 1_000,
    });
    return { store, productId };
  }

  it('rejects the 3rd open COD hold from the SAME phone (default cap 2); the first two succeed', async () => {
    const suffix = `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    const { store, productId } = await setUp(suffix);
    const phone = `+2010${suffix.replace(/\D/g, '').slice(0, 8).padEnd(8, '1')}`;

    await placeOrder(store.storeId, productId, { paymentMethod: 'cod', phone });
    await placeOrder(store.storeId, productId, { paymentMethod: 'cod', phone });

    await expect(
      placeOrder(store.storeId, productId, { paymentMethod: 'cod', phone })
    ).rejects.toMatchObject({ statusCode: 429, code: 'TOO_MANY_OPEN_HOLDS' });

    const count = await prisma.order.count({ where: { storeId: store.storeId } });
    expect(count).toBe(2); // the 3rd attempt never reserved stock or wrote a row
  });

  it('rejects the 3rd open InstaPay hold from the SAME email', async () => {
    const suffix = `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    const { store, productId } = await setUp(suffix);
    const email = `hold-cap-${suffix}@example.com`;

    await placeOrder(store.storeId, productId, { paymentMethod: 'instapay', email, phone: null });
    await placeOrder(store.storeId, productId, { paymentMethod: 'instapay', email, phone: null });

    await expect(
      placeOrder(store.storeId, productId, { paymentMethod: 'instapay', email, phone: null })
    ).rejects.toBeInstanceOf(AppError);
  });

  it('rejects the 3rd open COD hold from the SAME checkout IP once the (lower, configured-for-this-test) IP cap is reached, with no phone/email', async () => {
    // IP gets a separately-configurable, normally MUCH looser cap than
    // phone/email (CGNAT tolerance — see lib/stock-hold-cap.ts). Pin it down
    // to the identity cap here so this test still proves the IP branch works
    // without placing 9 real orders.
    process.env.OPEN_UNPAID_HOLD_IP_CAP = '2';
    const suffix = `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    const { store, productId } = await setUp(suffix);
    const ip = '203.0.113.7';

    await placeOrder(store.storeId, productId, {
      paymentMethod: 'cod',
      phone: null,
      email: null,
      ip,
    });
    await placeOrder(store.storeId, productId, {
      paymentMethod: 'cod',
      phone: null,
      email: null,
      ip,
    });

    await expect(
      placeOrder(store.storeId, productId, { paymentMethod: 'cod', phone: null, email: null, ip })
    ).rejects.toMatchObject({ statusCode: 429, code: 'TOO_MANY_OPEN_HOLDS' });
  });

  it('allows eight distinct contacts on one CGNAT IP, then rejects the ninth (ceiling set to 8; the default is 40 per 24 h, QA-HOLDS-1)', async () => {
    process.env.OPEN_UNPAID_HOLD_IP_CAP = '8';
    const suffix = `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    const { store, productId } = await setUp(suffix);
    const ip = '203.0.113.8';
    for (let i = 0; i < 8; i++) {
      const order = await placeOrder(store.storeId, productId, {
        paymentMethod: 'cod',
        phone: `+20100000000${i}`,
        email: `cgnat-${i}@example.com`,
        ip,
      });
      expect(order.id).toBeTruthy();
    }
    await expect(
      placeOrder(store.storeId, productId, {
        paymentMethod: 'cod',
        phone: '+201000000008',
        email: 'cgnat-8@example.com',
        ip,
      })
    ).rejects.toMatchObject({ code: 'TOO_MANY_OPEN_HOLDS' });
    expect(await prisma.order.count({ where: { storeId: store.storeId } })).toBe(8);
  });

  it('serializes simultaneous holds and rolls rejected attempts back without consuming inventory', async () => {
    const suffix = `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    const { store, productId } = await setUp(suffix);
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () =>
        placeOrder(store.storeId, productId, { paymentMethod: 'cod', phone: '+201011111111' })
      )
    );
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(2);
    for (const result of results) {
      if (result.status === 'rejected') expect(result.reason.code).toBe('TOO_MANY_OPEN_HOLDS');
    }
    expect(await prisma.order.count({ where: { storeId: store.storeId } })).toBe(2);
    expect((await prisma.product.findUniqueOrThrow({ where: { id: productId } })).inventory).toBe(
      98
    );
  });

  it('matches differently cased and padded email identities, including legacy rows', async () => {
    const suffix = `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    const { store, productId } = await setUp(suffix);
    const first = await placeOrder(store.storeId, productId, {
      paymentMethod: 'instapay',
      phone: null,
      email: 'Buyer@example.com',
    });
    await prisma.order.update({
      where: { id: first.id },
      data: {
        shippingAddress: {
          ...DEFAULT_TEST_SHIPPING_ADDRESS,
          phone: null,
          email: ' Buyer@Example.com ',
        },
      },
    });
    await placeOrder(store.storeId, productId, {
      paymentMethod: 'instapay',
      phone: null,
      email: 'buyer@example.com',
    });
    await expect(
      placeOrder(store.storeId, productId, {
        paymentMethod: 'instapay',
        phone: null,
        email: 'BUYER@EXAMPLE.COM',
      })
    ).rejects.toMatchObject({ code: 'TOO_MANY_OPEN_HOLDS' });
  });

  it('a normal customer placing one or two legitimate COD orders is never blocked', async () => {
    const suffix = `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    const { store, productId } = await setUp(suffix);
    const phone = `+2011${suffix.replace(/\D/g, '').slice(0, 8).padEnd(8, '2')}`;

    const first = await placeOrder(store.storeId, productId, { paymentMethod: 'cod', phone });
    const second = await placeOrder(store.storeId, productId, { paymentMethod: 'cod', phone });
    expect(first.id).toBeTruthy();
    expect(second.id).toBeTruthy();
  });

  it('caps a gateway-labelled hold at the looser gateway cap (5): five succeed, the sixth is rejected (S4-1)', async () => {
    const suffix = `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    const { store, productId } = await setUp(suffix);
    const phone = `+2012${suffix.replace(/\D/g, '').slice(0, 8).padEnd(8, '3')}`;

    for (let i = 0; i < 5; i++) {
      const order = await placeOrder(store.storeId, productId, { paymentMethod: 'paymob', phone });
      expect(order.id).toBeTruthy();
    }
    await expect(
      placeOrder(store.storeId, productId, { paymentMethod: 'paymob', phone })
    ).rejects.toMatchObject({ statusCode: 429, code: 'TOO_MANY_OPEN_HOLDS' });
  });

  it('an invented method label gets no way around the cap (S4-1)', async () => {
    process.env.OPEN_UNPAID_GATEWAY_HOLD_CAP = '1';
    const suffix = `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    const { store, productId } = await setUp(suffix);
    const phone = `+2014${suffix.replace(/\D/g, '').slice(0, 8).padEnd(8, '5')}`;

    await placeOrder(store.storeId, productId, { paymentMethod: 'card-xyz', phone });
    await expect(
      placeOrder(store.storeId, productId, { paymentMethod: 'card-xyz', phone })
    ).rejects.toMatchObject({ statusCode: 429 });
    delete process.env.OPEN_UNPAID_GATEWAY_HOLD_CAP;
  });

  it('respects a configured lower cap (OPEN_UNPAID_HOLD_CAP=1)', async () => {
    process.env.OPEN_UNPAID_HOLD_CAP = '1';
    const suffix = `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    const { store, productId } = await setUp(suffix);
    const phone = `+2013${suffix.replace(/\D/g, '').slice(0, 8).padEnd(8, '4')}`;

    await placeOrder(store.storeId, productId, { paymentMethod: 'cod', phone });
    await expect(
      placeOrder(store.storeId, productId, { paymentMethod: 'cod', phone })
    ).rejects.toMatchObject({ statusCode: 429 });
  });
});
