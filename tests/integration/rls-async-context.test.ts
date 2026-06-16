/**
 * RLS async-context regression guard
 *
 * Verifies the tenant-isolation contract that FORCE row-level security gives
 * orders, and that the async-context helpers (runInTenantContext / withRlsBypass)
 * behave as the production API + Inngest/webhook paths rely on.
 *
 * The current, intentional policy shape is **allow-contextless**:
 *   USING ( current_store_id() IS NULL OR store_id = current_store_id() )
 * i.e. a query with NO `app.current_store_id` set sees all rows (so webhook /
 * system-job paths that legitimately run outside tenant context are not
 * silently 0-rowed — see feedback-rls-force-cutover-breaks-preauth, the WBS P0).
 * The real isolation guarantee is therefore **cross-tenant denial**: a query
 * scoped to store B must NOT see store A's rows.
 *
 * CI role note: DATABASE_URL connects as a superuser (table owner), and
 * superusers bypass FORCE RLS entirely. So — exactly like
 * tenant-isolation.test.ts — `runAsForceApp` drops to the `force_app` role
 * (SET LOCAL ROLE, reverts on COMMIT) so the policy is actually evaluated.
 *
 * Runs only when DATABASE_URL is set (integration / CI environment). The
 * test creates its own store + order and cleans up after itself.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { prisma, runInTenantContext, withRlsBypass } from '@force/database';

// Skip when there is no real DB (unit-test environment)
const hasDb =
  !!process.env.DATABASE_URL && !process.env.DATABASE_URL.includes('localhost:5432/test_db');

// A store id the test order does NOT belong to — used to prove cross-tenant denial.
const FOREIGN_STORE_ID = '00000000-0000-0000-0000-000000000000';

/**
 * Execute fn as the `force_app` role with `app.current_store_id` = storeCtx
 * (null/'' → contextless). Both GUC changes are LOCAL and revert on COMMIT, so
 * Postgres evaluates the `TO force_app` policies exactly as production does,
 * even though DATABASE_URL is a superuser connection.
 */
async function runAsForceApp<T>(
  storeCtx: string | null,
  fn: (tx: PrismaClient) => Promise<T>
): Promise<T> {
  return prisma.$transaction(
    async tx => {
      await tx.$executeRawUnsafe(`SET LOCAL ROLE force_app`);
      await tx.$executeRawUnsafe(
        `SET LOCAL app.current_store_id = '${(storeCtx ?? '').replace(/'/g, "''")}'`
      );
      return fn(tx as unknown as PrismaClient);
    },
    { maxWait: 10000, timeout: 30000 }
  ) as Promise<T>;
}

describe.skipIf(!hasDb)('RLS async-context guard', () => {
  let storeId: string;
  let orderId: string;
  let customerId: string;
  let ownerId: string;

  beforeAll(async () => {
    // Create a minimal store + customer + order so we have rows to test against.
    // Use withRlsBypass for the setup writes (no tenant context active yet).
    // Add process.pid to ensure uniqueness even with retries (vitest retry: 1)
    const uniqueSuffix = `${Date.now()}-${process.pid}-${Math.random().toString(36).substring(7)}`;

    // Clean up any previous failed attempts first (from retries)
    await withRlsBypass(async tx => {
      // Delete any existing test data from previous failed attempts
      await tx.order
        .deleteMany({
          where: { orderNumber: { startsWith: 'RLS-TEST-' } },
        })
        .catch(() => {});
      await tx.user
        .deleteMany({
          where: {
            OR: [
              { email: { startsWith: 'rls-owner-' } },
              { email: { startsWith: 'rls-test-customer-' } },
            ],
          },
        })
        .catch(() => {});
      await tx.store
        .deleteMany({
          where: { slug: { startsWith: 'rls-test-' } },
        })
        .catch(() => {});
    });

    await withRlsBypass(async tx => {
      // Create an owner user first
      const owner = await tx.user.create({
        data: {
          email: `rls-owner-${uniqueSuffix}@example.com`,
          passwordHash: 'not-a-real-hash',
          role: 'store_admin',
          firstName: 'RLS',
          lastName: 'Test',
        },
      });
      ownerId = owner.id;

      const store = await tx.store.create({
        data: {
          name: 'rls-test-store',
          slug: `rls-test-${uniqueSuffix}`,
          template: 'modern',
          currency: 'KWD',
          ownerId: owner.id,
        },
      });
      storeId = store.id;

      const customer = await tx.user.create({
        data: {
          email: `rls-test-customer-${uniqueSuffix}@example.com`,
          passwordHash: 'not-a-real-hash',
          role: 'customer',
          firstName: 'RLS',
          lastName: 'Customer',
          storeId: store.id, // Add storeId for customer to comply with unique constraint
        },
      });
      customerId = customer.id;

      const order = await tx.order.create({
        data: {
          storeId,
          customerId,
          orderNumber: `RLS-TEST-${uniqueSuffix}`,
          status: 'confirmed',
          paymentStatus: 'paid',
          subtotal: 1000,
          tax: 0,
          shipping: 0,
          discount: 0,
          total: 1000,
          currency: 'KWD',
          shippingAddress: {},
          billingAddress: {},
        },
      });
      orderId = order.id;
    });
  });

  afterAll(async () => {
    // Clean up in reverse dependency order.
    if (orderId) {
      await withRlsBypass(tx => tx.order.delete({ where: { id: orderId } })).catch(() => {});
    }
    if (customerId) {
      await withRlsBypass(tx => tx.user.delete({ where: { id: customerId } })).catch(() => {});
    }
    if (storeId) {
      await withRlsBypass(tx => tx.store.delete({ where: { id: storeId } })).catch(() => {});
    }
    if (ownerId) {
      await withRlsBypass(tx => tx.user.delete({ where: { id: ownerId } })).catch(() => {});
    }
  });

  it('as force_app, a read scoped to a FOREIGN store cannot see the order (cross-tenant RLS denial)', async () => {
    // The core isolation guarantee: store B context must not see store A rows.
    // If this starts returning the row, the tenant RLS policy has regressed.
    const row = await runAsForceApp(FOREIGN_STORE_ID, tx =>
      tx.order.findUnique({ where: { id: orderId } })
    );
    expect(row).toBeNull();
  });

  it('as force_app, a write scoped to a FOREIGN store matches zero rows (cross-tenant write denial)', async () => {
    // RLS filters the WHERE to zero rows → Prisma throws P2025 (record not found).
    await expect(
      runAsForceApp(FOREIGN_STORE_ID, tx =>
        tx.order.update({ where: { id: orderId }, data: { customerNotes: 'should-not-land' } })
      )
    ).rejects.toThrow();
  });

  it('as force_app WITH the order’s store context, the order is visible (and writable)', async () => {
    const row = await runAsForceApp(storeId, tx => tx.order.findUnique({ where: { id: orderId } }));
    expect(row?.id).toBe(orderId);

    const updated = await runAsForceApp(storeId, tx =>
      tx.order.update({ where: { id: orderId }, data: { customerNotes: 'rls-context-write' } })
    );
    expect(updated.customerNotes).toBe('rls-context-write');

    // Reset
    await withRlsBypass(tx =>
      tx.order.update({ where: { id: orderId }, data: { customerNotes: null } })
    );
  });

  it('as force_app with NO context, the order is visible — allow-contextless (webhook/system-job safe)', async () => {
    // Deliberate design: current_store_id() IS NULL → policy allows, so a
    // legitimate no-context caller (Inngest job, payment webhook) is NOT 0-rowed.
    const row = await runAsForceApp(null, tx => tx.order.findUnique({ where: { id: orderId } }));
    expect(row?.id).toBe(orderId);
  });

  it('runInTenantContext returns the row (production tenant-scoped path)', async () => {
    const row = await runInTenantContext(storeId, () =>
      prisma.order.findUnique({ where: { id: orderId } })
    );
    expect(row).not.toBeNull();
    expect(row?.id).toBe(orderId);
  });

  it('withRlsBypass returns the row regardless of context (cross-tenant system path)', async () => {
    const row = await withRlsBypass(tx => tx.order.findUnique({ where: { id: orderId } }));
    expect(row).not.toBeNull();
    expect(row?.id).toBe(orderId);
  });
});
