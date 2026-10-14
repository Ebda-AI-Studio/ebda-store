/**
 * RLS async-context regression guard
 *
 * Verifies the tenant-isolation contract that STRICT, FORCED row-level security gives
 * orders (migration 20261004000000_ebda_strict_rls), and that the async-context helpers
 * (runInTenantContext / withOwnerTx) behave as the production API + Inngest/webhook paths
 * rely on.
 *
 * The policy is **strict**:
 *   USING / WITH CHECK ( store_id = nullif(current_setting('app.current_store_id', true), '') )
 * A query with NO store set sees NO rows and cannot write (there is no allow-contextless
 * branch and no bypass setting). Paths that legitimately start without a store use a SECURITY
 * DEFINER function or `runInStoreScope` / `withStore` (see apps/api/src/lib/definer.ts); the
 * cross-tenant denial is that a query scoped to store B must NOT see store A's rows.
 *
 * CI role note: DATABASE_URL connects as a superuser (table owner), and superusers bypass FORCE
 * RLS entirely. So `runAsApp` drops to the `ebda_app` role (SET LOCAL ROLE, reverts on COMMIT)
 * so the policy is actually evaluated. tests/integration/rls-ebda-app.test.ts proves the same
 * on a real ebda_app LOGIN connection.
 *
 * Runs only when DATABASE_URL is set (integration / CI environment). The
 * test creates its own store + order and cleans up after itself.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { prisma, runInTenantContext, withOwnerTx } from '@ebda/database';

// Skip when there is no real DB (unit-test environment)
const hasDb =
  !!process.env.DATABASE_URL && !process.env.DATABASE_URL.includes('localhost:5432/test_db');

// A store id the test order does NOT belong to — used to prove cross-tenant denial.
const FOREIGN_STORE_ID = '00000000-0000-0000-0000-000000000000';

/**
 * Execute fn as the `ebda_app` role with `app.current_store_id` = storeCtx
 * (null/'' → contextless). Both changes are LOCAL and revert on COMMIT, so
 * Postgres evaluates the `TO ebda_app` policies exactly as production does,
 * even though DATABASE_URL is a superuser connection.
 */
async function runAsApp<T>(
  storeCtx: string | null,
  fn: (tx: PrismaClient) => Promise<T>
): Promise<T> {
  return prisma.$transaction(
    async tx => {
      await tx.$executeRawUnsafe(`SET LOCAL ROLE ebda_app`);
      await tx.$queryRawUnsafe(
        `SELECT set_config('app.current_store_id', $1, true)`,
        storeCtx ?? ''
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
    // Use withOwnerTx for the setup writes (no tenant context active yet).
    // Add process.pid to ensure uniqueness even with retries (vitest retry: 1)
    const uniqueSuffix = `${Date.now()}-${process.pid}-${Math.random().toString(36).substring(7)}`;

    // Clean up any previous failed attempts first (from retries)
    await withOwnerTx(async tx => {
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

    await withOwnerTx(async tx => {
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
          currency: 'EGP',
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
          currency: 'EGP',
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
      await withOwnerTx(tx => tx.order.delete({ where: { id: orderId } })).catch(() => {});
    }
    if (customerId) {
      await withOwnerTx(tx => tx.user.delete({ where: { id: customerId } })).catch(() => {});
    }
    if (storeId) {
      await withOwnerTx(tx => tx.store.delete({ where: { id: storeId } })).catch(() => {});
    }
    if (ownerId) {
      await withOwnerTx(tx => tx.user.delete({ where: { id: ownerId } })).catch(() => {});
    }
  });

  it('as ebda_app, a read scoped to a FOREIGN store cannot see the order (cross-tenant RLS denial)', async () => {
    // The core isolation guarantee: store B context must not see store A rows.
    // If this starts returning the row, the tenant RLS policy has regressed.
    const row = await runAsApp(FOREIGN_STORE_ID, tx =>
      tx.order.findUnique({ where: { id: orderId } })
    );
    expect(row).toBeNull();
  });

  it('as ebda_app, a write scoped to a FOREIGN store matches zero rows (cross-tenant write denial)', async () => {
    // RLS filters the WHERE to zero rows → Prisma throws P2025 (record not found).
    await expect(
      runAsApp(FOREIGN_STORE_ID, tx =>
        tx.order.update({ where: { id: orderId }, data: { customerNotes: 'should-not-land' } })
      )
    ).rejects.toThrow();
  });

  it('as ebda_app WITH the order’s store context, the order is visible (and writable)', async () => {
    const row = await runAsApp(storeId, tx => tx.order.findUnique({ where: { id: orderId } }));
    expect(row?.id).toBe(orderId);

    const updated = await runAsApp(storeId, tx =>
      tx.order.update({ where: { id: orderId }, data: { customerNotes: 'rls-context-write' } })
    );
    expect(updated.customerNotes).toBe('rls-context-write');

    // Reset
    await withOwnerTx(tx =>
      tx.order.update({ where: { id: orderId }, data: { customerNotes: null } })
    );
  });

  it('as ebda_app with NO context, the order is invisible and cannot be written (strict: no allow-contextless branch)', async () => {
    // Deliberate design: no store set → no rows. A legitimate no-context caller (Inngest job,
    // payment webhook) resolves its store through a definer or runInStoreScope instead.
    const row = await runAsApp(null, tx => tx.order.findUnique({ where: { id: orderId } }));
    expect(row).toBeNull();
    await expect(
      runAsApp(null, tx =>
        tx.order.update({ where: { id: orderId }, data: { customerNotes: 'should-not-land' } })
      )
    ).rejects.toThrow();
  });

  it('runInTenantContext returns the row (production tenant-scoped path)', async () => {
    const row = await runInTenantContext(storeId, () =>
      prisma.order.findUnique({ where: { id: orderId } })
    );
    expect(row).not.toBeNull();
    expect(row?.id).toBe(orderId);
  });

  it('an owner-role connection (withOwnerTx) returns the row regardless of context (jobs/scripts only)', async () => {
    const row = await withOwnerTx(tx => tx.order.findUnique({ where: { id: orderId } }));
    expect(row).not.toBeNull();
    expect(row?.id).toBe(orderId);
  });
});
