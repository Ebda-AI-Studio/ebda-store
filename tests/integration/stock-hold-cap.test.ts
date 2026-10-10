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
 * `lib/stock-hold-cap.ts` closes both: `assertStockHoldCapNotExceeded` runs
 * inside `OrderService.create` before any cart/stock read, rejecting a NEW
 * cod/instapay order once the same phone, email OR checkout IP already has
 * `OPEN_UNPAID_HOLD_CAP` (default 2) open (pending/awaiting-confirmation,
 * unpaid) holds on the store. A real-time gateway (paymob/kashier, captured
 * synchronously) is explicitly NOT capped.
 *
 * Same fixtures + "real Postgres, no DB bypass" convention as
 * `tests/integration/soft-deleted-product-checkout-block.test.ts`.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { prisma } from '@force/database';
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

  it('rejects the 3rd open COD hold from the SAME checkout IP even with no phone/email and a varying one otherwise', async () => {
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

  it('a normal customer placing one or two legitimate COD orders is never blocked', async () => {
    const suffix = `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    const { store, productId } = await setUp(suffix);
    const phone = `+2011${suffix.replace(/\D/g, '').slice(0, 8).padEnd(8, '2')}`;

    const first = await placeOrder(store.storeId, productId, { paymentMethod: 'cod', phone });
    const second = await placeOrder(store.storeId, productId, { paymentMethod: 'cod', phone });
    expect(first.id).toBeTruthy();
    expect(second.id).toBeTruthy();
  });

  it('does NOT cap a real-time-captured gateway method (paymob) — unbounded orders from the same phone all succeed', async () => {
    const suffix = `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    const { store, productId } = await setUp(suffix);
    const phone = `+2012${suffix.replace(/\D/g, '').slice(0, 8).padEnd(8, '3')}`;

    for (let i = 0; i < 4; i++) {
      const order = await placeOrder(store.storeId, productId, { paymentMethod: 'paymob', phone });
      expect(order.id).toBeTruthy();
    }
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
