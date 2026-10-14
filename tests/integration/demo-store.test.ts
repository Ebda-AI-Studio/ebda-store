/**
 * A demo store (stores.is_demo) refuses every order-creating path: no order row, no order item,
 * no stock movement. Reads `is_demo` under the ebda_app role (strict RLS) too.
 *
 * Paths checked (all funnel through plan-limit.service `assertOrderAllowed`):
 *   OrderService.create          storefront checkout, public routes, MCP order tools
 *   OrderService.createAdminOrder merchant phone/manual orders
 *   payment-links.routes          WhatsApp payment link (calls assertOrderAllowed before any write)
 * A non-demo store is unaffected.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { prisma, withRlsBypass, createPrismaClient, runWithRequestDb } from '@force/database';
import { AppError } from '@api/middleware/error-handler';
import { OrderService } from '@api/services/order.service';
import { assertOrderAllowed } from '@api/services/plan-limit.service';
import { awaitDeferredWork } from '@api/lib/after-tenant-commit';
import {
  hasDb,
  seedBundleStore,
  seedProduct,
  cartSessionId,
  addItemToCart,
  stockOf,
  DEFAULT_TEST_SHIPPING_ADDRESS,
} from '../helpers/bundle-fixtures';

const OWNER_URL = process.env.DIRECT_URL || process.env.DATABASE_URL || '';
function appUrl(): string {
  const u = new URL(OWNER_URL);
  u.username = 'ebda_app';
  u.password = process.env.EBDA_APP_PASSWORD || 'ci-only-app-pw';
  return u.toString();
}
const asApp = <T>(fn: () => Promise<T>) =>
  runWithRequestDb(() => createPrismaClient({ connectionString: appUrl(), max: 3 }), fn, {
    beforeDisconnect: () => awaitDeferredWork(5000),
  });

const storeIds: string[] = [];

async function seed(isDemo: boolean) {
  const suffix = `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const store = await seedBundleStore(suffix);
  storeIds.push(store.storeId);
  if (isDemo) {
    await withRlsBypass(tx =>
      tx.store.update({ where: { id: store.storeId }, data: { isDemo: true } })
    );
  }
  const productId = await seedProduct(store.storeId, `${suffix}-p`, {
    inventory: 10,
    price: 1_000,
  });
  return { ...store, productId, suffix };
}

const counts = (storeId: string) =>
  withRlsBypass(async tx => ({
    orders: await tx.order.count({ where: { storeId } }),
    items: await tx.orderItem.count({ where: { order: { storeId } } }),
  }));

describe.skipIf(!hasDb)('demo store refuses orders', () => {
  afterAll(async () => {
    await withRlsBypass(async tx => {
      await tx.orderItem.deleteMany({ where: { order: { storeId: { in: storeIds } } } });
      await tx.order.deleteMany({ where: { storeId: { in: storeIds } } });
    });
  });

  it('OrderService.create: 403 DEMO_STORE, no order row, no item row, stock untouched', async () => {
    const s = await seed(true);
    const sessionId = cartSessionId('demo-create');
    await addItemToCart(s.storeId, sessionId, s.productId, 1);

    let thrown: AppError | undefined;
    try {
      await OrderService.create(s.storeId, undefined, sessionId, {
        shippingAddress: DEFAULT_TEST_SHIPPING_ADDRESS,
        paymentMethod: 'paymob',
      });
    } catch (e) {
      thrown = e as AppError;
    }
    expect(thrown).toBeInstanceOf(AppError);
    expect(thrown?.statusCode).toBe(403);
    expect(thrown?.code).toBe('DEMO_STORE');
    expect(await counts(s.storeId)).toEqual({ orders: 0, items: 0 });
    expect(await stockOf(s.productId)).toBe(10);
  });

  it('OrderService.createAdminOrder: 403 DEMO_STORE and nothing written', async () => {
    const s = await seed(true);
    await expect(
      OrderService.createAdminOrder(
        s.storeId,
        s.ownerId,
        {
          items: [{ productId: s.productId, quantity: 1 }],
          shippingAddress: DEFAULT_TEST_SHIPPING_ADDRESS,
          paymentMethod: 'cod',
        } as never,
        { role: 'store_admin' }
      )
    ).rejects.toMatchObject({ statusCode: 403, code: 'DEMO_STORE' });
    expect(await counts(s.storeId)).toEqual({ orders: 0, items: 0 });
    expect(await stockOf(s.productId)).toBe(10);
  });

  it('assertOrderAllowed reads is_demo under the ebda_app role (strict RLS)', async () => {
    const s = await seed(true);
    await expect(asApp(() => assertOrderAllowed(s.storeId))).rejects.toMatchObject({
      statusCode: 403,
      code: 'DEMO_STORE',
    });
  });

  it('a non-demo store still takes orders', async () => {
    const s = await seed(false);
    await expect(asApp(() => assertOrderAllowed(s.storeId))).resolves.toBeUndefined();
    const sessionId = cartSessionId('non-demo-create');
    await addItemToCart(s.storeId, sessionId, s.productId, 1);
    const order = await OrderService.create(s.storeId, undefined, sessionId, {
      shippingAddress: DEFAULT_TEST_SHIPPING_ADDRESS,
      paymentMethod: 'paymob',
    });
    expect(order.id).toBeTruthy();
    expect((await counts(s.storeId)).orders).toBe(1);
  });

  it('an unknown store id is still STORE_NOT_FOUND, not DEMO_STORE', async () => {
    await expect(
      prisma.$transaction(async () => assertOrderAllowed(crypto.randomUUID()))
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});
