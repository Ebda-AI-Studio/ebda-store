import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { prisma, withRlsBypass } from '@force/database';

// F3: prove cross-tenant isolation holds at BOTH layers:
//  1. RLS — a query executed as the `force_app` role with storeA context must
//     NOT see store B rows.
//  2. Application scoping — OrderService.getById(storeA, orderB) must return null.
//
// This test is a CI hard gate: if a future change drops a storeId filter OR the
// RLS policy regresses, one of these assertions fails.
//
// CI role note: DATABASE_URL connects as the `test` superuser (table owner).
// Postgres superusers bypass FORCE ROW LEVEL SECURITY entirely, so plain
// `runInTenantContext` (which only sets `app.current_store_id`) would NOT
// exercise the `rls_orders_tenant` policy — the superuser sees all rows.
// `runAsTenantRole` below issues `SET LOCAL ROLE force_app` inside the
// transaction so Postgres evaluates the policy as it would in production.
// `force_app` is created by migration 20260404000000_add_rls_policies and is
// guaranteed present after `prisma migrate deploy` runs in CI.

/**
 * Execute fn inside a transaction that (a) switches to the `force_app` role
 * and (b) sets `app.current_store_id`. Both GUC changes are LOCAL (revert on
 * COMMIT/ROLLBACK). This faithfully reproduces how the production API connects
 * for tenant-scoped queries, enabling the RLS policies scoped `TO force_app`
 * to be exercised in CI even though DATABASE_URL is a superuser connection.
 */
async function runAsTenantRole(
  storeId: string,
  fn: (tx: PrismaClient) => Promise<{ id: string }[]>
): Promise<{ id: string }[]> {
  return prisma.$transaction(
    async tx => {
      // Drop to the application role — reverts on COMMIT / ROLLBACK.
      await tx.$executeRawUnsafe(`SET LOCAL ROLE force_app`);
      await tx.$executeRawUnsafe(
        `SET LOCAL app.current_store_id = '${storeId.replace(/'/g, "''")}'`
      );
      return fn(tx as unknown as PrismaClient);
    },
    { maxWait: 10000, timeout: 30000 }
  ) as Promise<{ id: string }[]>;
}

const TEST_PREFIX = 'titest-';

let storeA = '';
let storeB = '';
let orderB = '';

async function makeStore(slug: string): Promise<string> {
  const user = await prisma.user.create({
    data: {
      email: `${TEST_PREFIX}${slug}-${Date.now()}@test.com`,
      passwordHash: 'hashed',
      firstName: 'Tenant',
      lastName: 'Isolation',
      role: 'store_admin',
    },
  });
  const store = await prisma.store.create({
    data: {
      slug,
      name: `Tenant Isolation ${slug}`,
      ownerId: user.id,
    },
  });
  return store.id;
}

async function cleanup(): Promise<void> {
  // Run with RLS bypass so cleanup is not itself filtered by tenant context.
  await withRlsBypass(async tx => {
    await tx.$executeRawUnsafe(
      `DELETE FROM public.orders WHERE store_id IN (SELECT id FROM public.stores WHERE slug LIKE '${TEST_PREFIX}%')`
    );
    await tx.$executeRawUnsafe(`DELETE FROM public.stores WHERE slug LIKE '${TEST_PREFIX}%'`);
    await tx.$executeRawUnsafe(`DELETE FROM public.users WHERE email LIKE '${TEST_PREFIX}%'`);
  });
}

beforeAll(async () => {
  await cleanup();
  storeA = await makeStore(`${TEST_PREFIX}a`);
  storeB = await makeStore(`${TEST_PREFIX}b`);

  const order = await prisma.order.create({
    data: {
      storeId: storeB,
      orderNumber: `${TEST_PREFIX}order-1`,
      subtotal: 10,
      total: 10,
      shippingAddress: {},
      billingAddress: {},
    },
  });
  orderB = order.id;
});

afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

describe('cross-tenant isolation (integration)', () => {
  it('store A context cannot read store B orders via RLS', async () => {
    // Use runAsTenantRole so the `rls_orders_tenant` policy is evaluated.
    // A plain runInTenantContext call would be skipped for the CI superuser.
    const rows = await runAsTenantRole(storeA, tx => tx.order.findMany({ where: {} }));
    expect(rows.find(o => o.id === orderB)).toBeUndefined();
  });

  it('store B context CAN read its own order (control)', async () => {
    // Verify the GUC filter passes rows that belong to the active store context.
    const rows = await runAsTenantRole(storeB, tx => tx.order.findMany({ where: {} }));
    expect(rows.find(o => o.id === orderB)).toBeDefined();
  });

  it('OrderService.getById refuses a cross-store id', async () => {
    const { OrderService } = await import('../../apps/api/src/services/order.service');
    // getById throws AppError(404) when the storeId filter excludes the order —
    // this is the application-layer isolation guarantee (independent of RLS).
    await expect(OrderService.getById(storeA, orderB)).rejects.toMatchObject({
      statusCode: 404,
      code: 'NOT_FOUND',
    });
  });

  it('OrderService.getById returns the order for its own store (control)', async () => {
    const { OrderService } = await import('../../apps/api/src/services/order.service');
    const found = await OrderService.getById(storeB, orderB);
    expect(found?.id).toBe(orderB);
  });
});
