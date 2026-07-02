/**
 * force_app REAL-LOGIN cross-tenant RLS proof (RLS cutover Phase 1c).
 *
 * Unlike `tenant-isolation.test.ts` / `rls-async-context.test.ts` (which run
 * against a superuser DATABASE_URL and use `SET LOCAL ROLE force_app` to
 * emulate the app role for individual queries), THIS file runs in its own CI
 * job (`.github/workflows/ci.yml` job `test-rls-force-app`) whose
 * DATABASE_URL / DIRECT_URL themselves authenticate as the real `force_app`
 * login role. Every `prisma.*` call in this file is a literal
 * force_app-authenticated query — the closest CI gets to production's
 * post-cutover connection (Phase 3: `DATABASE_URL` flips to `force_app` and
 * `ALLOW_BYPASSRLS_ROLE` is removed).
 *
 * Prerequisites the CI job sets up before this file runs (not this file's
 * job): migrations applied (which idempotently create `force_app` with DML
 * grants — 20260404000000_add_rls_policies — and the tenant/user-scoped
 * policies — 20260609000000_complete_force_rls_coverage +
 * 20260702170000_rls_close_denyall_tables), a CI-only password set on
 * `force_app` so it can log in over TCP, and a CI-only TRUNCATE grant so the
 * shared `tests/setup-e2e.ts` fixture reset doesn't 42501 (prod force_app has
 * no TRUNCATE and doesn't need it — see the CI job's comments).
 *
 * THE GATE (docs/plans/2026-07-02-rls-cutover.md Phase 1c): if any predicate
 * here is wrong, or a table is still deny-all for force_app, this file fails
 * — not prod.
 *
 * Coverage:
 *  - `products`     — direct store_id, representative store-scoped table.
 *  - `addresses`    — user-scoped (Phase 1b, NEW policy this PR adds):
 *                     current_user_id() / app.current_user_id GUC.
 *  - `payments`     — child-via-order (already policied by 20260609, proven
 *                     here under a REAL force_app login for the first time).
 *  - `return_items` — child-via-return (same as payments).
 *  - `system_settings` — platform-global, intentionally permissive.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma, withRlsBypass, runInTenantContext } from '@force/database';

const TEST_PREFIX = 'fatest-';

let storeA = '';
let storeB = '';
let userA = '';
let userB = '';
let productB = '';
let paymentB = '';
let returnItemB = '';
let addressA = '';
let addressB = '';

async function makeStoreWithOwner(slug: string): Promise<{ storeId: string; userId: string }> {
  return withRlsBypass(async tx => {
    const owner = await tx.user.create({
      data: {
        email: `${TEST_PREFIX}${slug}-${Date.now()}@test.com`,
        passwordHash: 'hashed',
        firstName: 'Force',
        lastName: 'App',
        role: 'store_admin',
      },
    });
    const store = await tx.store.create({
      data: { slug, name: `Force App Test ${slug}`, ownerId: owner.id },
    });
    return { storeId: store.id, userId: owner.id };
  });
}

async function cleanup(): Promise<void> {
  // Every write here runs with app.bypass_rls='true' so cleanup itself is
  // never filtered by the policies under test.
  await withRlsBypass(async tx => {
    await tx.$executeRawUnsafe(
      `DELETE FROM public.return_items WHERE return_id IN (SELECT id FROM public.returns WHERE return_number LIKE '${TEST_PREFIX}%')`
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM public.returns WHERE return_number LIKE '${TEST_PREFIX}%'`
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM public.payments WHERE order_id IN (SELECT id FROM public.orders WHERE order_number LIKE '${TEST_PREFIX}%')`
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM public.order_items WHERE order_id IN (SELECT id FROM public.orders WHERE order_number LIKE '${TEST_PREFIX}%')`
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM public.orders WHERE order_number LIKE '${TEST_PREFIX}%'`
    );
    await tx.$executeRawUnsafe(`DELETE FROM public.products WHERE slug LIKE '${TEST_PREFIX}%'`);
    await tx.$executeRawUnsafe(
      `DELETE FROM public.addresses WHERE address1 LIKE '${TEST_PREFIX}%'`
    );
    await tx.$executeRawUnsafe(`DELETE FROM public.stores WHERE slug LIKE '${TEST_PREFIX}%'`);
    await tx.$executeRawUnsafe(`DELETE FROM public.users WHERE email LIKE '${TEST_PREFIX}%'`);
  });
}

beforeAll(async () => {
  await cleanup();

  const a = await makeStoreWithOwner(`${TEST_PREFIX}a`);
  const b = await makeStoreWithOwner(`${TEST_PREFIX}b`);
  storeA = a.storeId;
  storeB = b.storeId;
  userA = a.userId;
  userB = b.userId;

  await withRlsBypass(async tx => {
    // ── products: direct store_id sample ──
    await tx.product.create({
      data: {
        storeId: storeA,
        name: `${TEST_PREFIX}prod-a`,
        slug: `${TEST_PREFIX}prod-a-${Date.now()}`,
        price: 1000,
      },
    });
    const prodB = await tx.product.create({
      data: {
        storeId: storeB,
        name: `${TEST_PREFIX}prod-b`,
        slug: `${TEST_PREFIX}prod-b-${Date.now()}`,
        price: 1000,
      },
    });
    productB = prodB.id;

    // ── addresses: user-scoped sample (Phase 1b) ──
    const addrA = await tx.address.create({
      data: {
        userId: userA,
        firstName: 'A',
        lastName: 'User',
        address1: `${TEST_PREFIX}addr-a`,
        city: 'Kuwait City',
        state: 'Kuwait',
      },
    });
    addressA = addrA.id;
    const addrB = await tx.address.create({
      data: {
        userId: userB,
        firstName: 'B',
        lastName: 'User',
        address1: `${TEST_PREFIX}addr-b`,
        city: 'Kuwait City',
        state: 'Kuwait',
      },
    });
    addressB = addrB.id;

    // ── orders/payments/returns chain on store B (child-via-order sample) ──
    const order = await tx.order.create({
      data: {
        storeId: storeB,
        orderNumber: `${TEST_PREFIX}order-${Date.now()}`,
        subtotal: 10,
        total: 10,
        shippingAddress: {},
        billingAddress: {},
      },
    });

    const payment = await tx.payment.create({
      data: { orderId: order.id, amount: 10, currency: 'KWD', provider: 'cod', status: 'pending' },
    });
    paymentB = payment.id;

    const orderItem = await tx.orderItem.create({
      data: {
        orderId: order.id,
        productId: prodB.id,
        productName: `${TEST_PREFIX}item`,
        quantity: 1,
        price: 10,
        total: 10,
      },
    });

    const ret = await tx.return.create({
      data: {
        storeId: storeB,
        orderId: order.id,
        customerId: userB,
        returnNumber: `${TEST_PREFIX}ret-${Date.now()}`,
        reason: 'rls-force-app-test',
      },
    });

    const retItem = await tx.returnItem.create({
      data: {
        returnId: ret.id,
        orderItemId: orderItem.id,
        productId: prodB.id,
        productName: `${TEST_PREFIX}item`,
        quantity: 1,
      },
    });
    returnItemB = retItem.id;
  });
});

afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

describe('force_app real-login: store-scoped table (products)', () => {
  it('store A context cannot see store B product', async () => {
    const row = await runInTenantContext(storeA, () =>
      prisma.product.findUnique({ where: { id: productB } })
    );
    expect(row).toBeNull();
  });

  it('store B context CAN see its own product (control)', async () => {
    const row = await runInTenantContext(storeB, () =>
      prisma.product.findUnique({ where: { id: productB } })
    );
    expect(row?.id).toBe(productB);
  });
});

describe('force_app real-login: addresses (user-scoped, Phase 1b policy)', () => {
  it('user A context cannot see user B address', async () => {
    // No store-scoped route exists for /addresses today (see
    // apps/api/src/routes/address.routes.ts — mounted bare, no :storeId), so
    // exercise the user-context GUC directly the same way runInTenantContext
    // does, via a raw SET LOCAL against the force_app connection.
    const row = await prisma.$transaction(async tx => {
      await tx.$executeRawUnsafe(`SET LOCAL app.current_user_id = '${userA}'`);
      return tx.address.findUnique({ where: { id: addressB } });
    });
    expect(row).toBeNull();
  });

  it('user A context CAN see their own address (control)', async () => {
    const row = await prisma.$transaction(async tx => {
      await tx.$executeRawUnsafe(`SET LOCAL app.current_user_id = '${userA}'`);
      return tx.address.findUnique({ where: { id: addressA } });
    });
    expect(row?.id).toBe(addressA);
  });

  it("no user context set — allow-contextless (matches today's unrestricted behavior)", async () => {
    const row = await prisma.address.findUnique({ where: { id: addressB } });
    expect(row?.id).toBe(addressB);
  });

  it('bypass sees any address regardless of user context', async () => {
    const row = await withRlsBypass(tx => tx.address.findUnique({ where: { id: addressB } }));
    expect(row?.id).toBe(addressB);
  });
});

describe('force_app real-login: payments (child via orders.store_id)', () => {
  it('store A context cannot see store B payment', async () => {
    const row = await runInTenantContext(storeA, () =>
      prisma.payment.findUnique({ where: { id: paymentB } })
    );
    expect(row).toBeNull();
  });

  it('store B context CAN see its own payment (control)', async () => {
    const row = await runInTenantContext(storeB, () =>
      prisma.payment.findUnique({ where: { id: paymentB } })
    );
    expect(row?.id).toBe(paymentB);
  });

  it('contextless read (payment webhook path) still sees the payment — NOT 0-rowed', async () => {
    const row = await prisma.payment.findUnique({ where: { id: paymentB } });
    expect(row?.id).toBe(paymentB);
  });
});

describe('force_app real-login: return_items (child via returns.store_id)', () => {
  it('store A context cannot see store B return item', async () => {
    const row = await runInTenantContext(storeA, () =>
      prisma.returnItem.findUnique({ where: { id: returnItemB } })
    );
    expect(row).toBeNull();
  });

  it('store B context CAN see its own return item (control)', async () => {
    const row = await runInTenantContext(storeB, () =>
      prisma.returnItem.findUnique({ where: { id: returnItemB } })
    );
    expect(row?.id).toBe(returnItemB);
  });
});

describe('force_app real-login: system_settings (platform-global, intentionally permissive)', () => {
  const key = `${TEST_PREFIX}setting-${Date.now()}`;

  afterAll(async () => {
    await prisma.systemSetting.deleteMany({ where: { key } });
  });

  it('is readable/writable under force_app with no tenant context (not deny-all)', async () => {
    const created = await prisma.systemSetting.create({
      data: { key, value: { ok: true }, category: 'test' },
    });
    expect(created.key).toBe(key);

    const found = await prisma.systemSetting.findUnique({ where: { key } });
    expect(found?.key).toBe(key);
  });

  it('is also readable under an active store context (USING(true) never restricts)', async () => {
    const row = await runInTenantContext(storeA, () =>
      prisma.systemSetting.findUnique({ where: { key } })
    );
    expect(row?.key).toBe(key);
  });
});
