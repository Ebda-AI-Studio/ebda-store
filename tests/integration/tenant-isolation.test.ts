import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma, runInTenantContext, withRlsBypass } from '@force/database';

// F3: prove cross-tenant isolation holds at BOTH layers:
//  1. RLS — a query run inside runInTenantContext(storeA) must not see store B rows.
//  2. Application scoping — OrderService.getById(storeA, orderB) must return null.
//
// This test is a CI hard gate: if a future change drops a storeId filter OR the
// RLS policy regresses (e.g. an owner-role connection makes RLS inert), one of
// these assertions fails.

const TEST_PREFIX = 'titest-';

let storeA = '';
let storeB = '';
let orderB = '';

async function makeStore(slug: string): Promise<string> {
  const user = await prisma.user.create({
    data: {
      email: `${slug}-${Date.now()}@test.com`,
      password: 'hashed',
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
    const rows = await runInTenantContext(storeA, () => prisma.order.findMany({ where: {} }));
    expect(rows.find(o => o.id === orderB)).toBeUndefined();
  });

  it('store B context CAN read its own order (control)', async () => {
    const rows = await runInTenantContext(storeB, () => prisma.order.findMany({ where: {} }));
    expect(rows.find(o => o.id === orderB)).toBeDefined();
  });

  it('OrderService.getById refuses a cross-store id', async () => {
    const { OrderService } = await import('../../apps/api/src/services/order.service');
    const found = await OrderService.getById(storeA, orderB);
    expect(found).toBeNull();
  });

  it('OrderService.getById returns the order for its own store (control)', async () => {
    const { OrderService } = await import('../../apps/api/src/services/order.service');
    const found = await OrderService.getById(storeB, orderB);
    expect(found?.id).toBe(orderB);
  });
});
