/**
 * Guest checkout of a BACKORDERED line, over HTTP, against the API running as
 * `ebda_app` (issue 2044).
 *
 * `backorder_lines` has a STRICT RLS policy — no contextless allowance — and
 * the public checkout (`POST /public/orders` → `OrderService.create`) runs with
 * NO ambient tenant context. The insert is admitted only because
 * `OrderService.create` calls `setTenantGucs(tx, { storeId })` at the top of
 * its money transaction. Without that line the insert is REJECTED inside
 * `withMoneyTx`, the whole order rolls back, and a guest who ordered a
 * backordered SKU gets a 500 with no order — the loud half of the class the
 * RLS cutover checklist carried alone.
 *
 * Nothing else walked this path as ebda_app: the RLS parity harness stops at
 * the cart, the unit tests stub `setTenantGucs` away, and rls-ebda-app.test.ts
 * proves the helper on every table, not the route. CI's integration job
 * runs the API server as `ebda_app` (ci.yml "Give ebda_app a CI-only login
 * for the API server"); fixtures here are written through the test harness's
 * superuser connection, like public-store-faqs-rls.test.ts.
 *
 * Retry-safe (CLAUDE.md): every fixture — user, store, product, cart session —
 * is keyed on a per-CALL unique suffix.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { prisma } from '@ebda/database';
import { API_BASE } from '../helpers/api-base';
import { hasDb, cartSessionId, DEFAULT_TEST_SHIPPING_ADDRESS } from '../helpers/bundle-fixtures';

const created: { storeIds: string[]; userIds: string[] } = { storeIds: [], userIds: [] };

async function seedBackorderStore() {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const owner = await prisma.user.create({
    data: {
      email: `backorder-rls-${suffix}@test.local`,
      passwordHash: 'x',
      firstName: 'Backorder',
      lastName: 'Rls',
      role: 'store_admin',
      emailVerified: true,
    },
  });
  created.userIds.push(owner.id);
  const store = await prisma.store.create({
    data: {
      name: `Backorder RLS ${suffix}`,
      slug: `backorder-rls-${suffix}`,
      ownerId: owner.id,
      status: 'active',
      currency: 'EGP',
      marketingPixels: {},
    },
  });
  created.storeIds.push(store.id);
  await prisma.storeFeature.create({
    data: { storeId: store.id, featureKey: 'inventory.backorder', enabled: true },
  });
  const product = await prisma.product.create({
    data: {
      storeId: store.id,
      name: `backorder-rls-product-${suffix}`,
      slug: `backorder-rls-product-${suffix}`,
      price: 2500,
      inventory: 1,
      trackInventory: true,
      allowBackorder: true,
      status: 'active',
    },
  });
  return { storeId: store.id, productId: product.id };
}

afterAll(async () => {
  if (!hasDb) return;
  const storeIds = created.storeIds;
  await prisma.backorderLine.deleteMany({ where: { storeId: { in: storeIds } } });
  await prisma.inventoryHistory.deleteMany({ where: { storeId: { in: storeIds } } });
  await prisma.orderItem.deleteMany({ where: { order: { storeId: { in: storeIds } } } });
  await prisma.order.deleteMany({ where: { storeId: { in: storeIds } } });
  await prisma.cartItem.deleteMany({ where: { cart: { storeId: { in: storeIds } } } });
  await prisma.cart.deleteMany({ where: { storeId: { in: storeIds } } });
  await prisma.product.deleteMany({ where: { storeId: { in: storeIds } } });
  await prisma.storeFeature.deleteMany({ where: { storeId: { in: storeIds } } });
  await prisma.store.deleteMany({ where: { id: { in: storeIds } } });
  await prisma.user.deleteMany({ where: { id: { in: created.userIds } } });
});

describe.skipIf(!hasDb)(
  'guest checkout of a backordered line under enforced RLS (issue 2044)',
  () => {
    it('POST /public/orders → 201 and a backorder_lines row, not a rolled-back 500', async () => {
      const { storeId, productId } = await seedBackorderStore();
      const headers = {
        'Content-Type': 'application/json',
        'x-store-id': storeId,
        'x-session-id': cartSessionId('backorder-rls'),
      };

      // In stock when it goes in the cart…
      const add = await fetch(`${API_BASE}/public/cart/items`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ productId, quantity: 1 }),
      });
      expect(add.status, await add.clone().text()).toBeLessThan(300);

      // …and sold out by checkout, so the conditional decrement misses and the
      // line is accepted as a backorder (feature + per-product flag both on).
      await prisma.product.update({ where: { id: productId }, data: { inventory: 0 } });

      const res = await fetch(`${API_BASE}/public/orders`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          shippingAddress: DEFAULT_TEST_SHIPPING_ADDRESS,
          // Non-COD: keeps the COD notification fanout out of a test about RLS.
          paymentMethod: 'paymob',
        }),
      });
      const body = (await res.json()) as {
        success: boolean;
        data?: { order: { id: string; items: Array<{ id: string; productId: string }> } };
        error?: { code: string; message: string };
      };
      expect(res.status, JSON.stringify(body.error ?? body)).toBe(201);
      const order = body.data!.order;

      const lines = await prisma.backorderLine.findMany({
        where: { storeId, orderItem: { orderId: order.id } },
        select: { productId: true, qty: true },
      });
      expect(lines).toEqual([{ productId, qty: 1 }]);

      // The unfloored backorder debt landed on the product row.
      const product = await prisma.product.findUnique({
        where: { id: productId },
        select: { inventory: true },
      });
      expect(product?.inventory).toBe(-1);
    });
  }
);
