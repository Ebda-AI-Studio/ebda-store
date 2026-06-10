/**
 * RLS async-context regression guard
 *
 * Verifies that FORCE row-level security (migration complete_force_rls_coverage)
 * correctly filters reads to zero when no tenant GUC is set, and that
 * runInTenantContext / withRlsBypass restore visibility.
 *
 * Why this matters: Inngest jobs and webhook handlers run outside the HTTP
 * request lifecycle and therefore outside the tenant-context middleware. Any
 * direct prisma.* call from these paths sees zero rows if the GUC is unset.
 * This test is the regression guard for the whole class.
 *
 * Runs only when DATABASE_URL is set (integration / CI environment). The
 * test creates its own store + order and cleans up after itself.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma, runInTenantContext, withRlsBypass } from '@force/database';

// Skip when there is no real DB (unit-test environment)
const hasDb =
  !!process.env.DATABASE_URL && !process.env.DATABASE_URL.includes('localhost:5432/test_db');

describe.skipIf(!hasDb)('RLS async-context guard', () => {
  let storeId: string;
  let orderId: string;
  let customerId: string;
  let ownerId: string;

  beforeAll(async () => {
    // Create a minimal store + customer + order so we have rows to test against.
    // Use withRlsBypass for the setup writes (no tenant context active yet).
    await withRlsBypass(async tx => {
      // Create an owner user first
      const owner = await tx.user.create({
        data: {
          email: `rls-owner-${Date.now()}@example.com`,
          passwordHash: 'not-a-real-hash',
          role: 'store_admin',
        },
      });
      ownerId = owner.id;

      const store = await tx.store.create({
        data: {
          name: 'rls-test-store',
          slug: `rls-test-${Date.now()}`,
          template: 'modern',
          currency: 'KWD',
          ownerId: owner.id,
        },
      });
      storeId = store.id;

      const customer = await tx.user.create({
        data: {
          email: `rls-test-${Date.now()}@example.com`,
          passwordHash: 'not-a-real-hash',
          role: 'customer',
        },
      });
      customerId = customer.id;

      const order = await tx.order.create({
        data: {
          storeId,
          customerId,
          orderNumber: `RLS-TEST-${Date.now()}`,
          status: 'confirmed',
          paymentStatus: 'paid',
          subtotal: 1000,
          tax: 0,
          shipping: 0,
          discount: 0,
          total: 1000,
          currency: 'KWD',
          shippingAddress: {},
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

  it('raw prisma.order.findUnique returns null without tenant context (RLS filters it)', async () => {
    // This is the core regression check: a bare prisma call from an
    // async context (no SET LOCAL app.current_store_id) must return null.
    // If this test starts failing it means RLS was disabled — re-enable it.
    const row = await prisma.order.findUnique({ where: { id: orderId } });
    expect(row).toBeNull();
  });

  it('prisma.order.findUnique returns the row inside runInTenantContext', async () => {
    const row = await runInTenantContext(storeId, () =>
      prisma.order.findUnique({ where: { id: orderId } })
    );
    expect(row).not.toBeNull();
    expect(row?.id).toBe(orderId);
  });

  it('prisma.order.findUnique returns the row inside withRlsBypass', async () => {
    const row = await withRlsBypass(tx => tx.order.findUnique({ where: { id: orderId } }));
    expect(row).not.toBeNull();
    expect(row?.id).toBe(orderId);
  });

  it('an order write from a no-context caller succeeds only inside runInTenantContext', async () => {
    // A bare update must fail (RLS filters the WHERE to zero rows → Prisma throws P2025).
    await expect(
      prisma.order.update({
        where: { id: orderId },
        data: { customerNotes: 'should-not-land' },
      })
    ).rejects.toThrow();

    // The same update inside runInTenantContext must succeed.
    const updated = await runInTenantContext(storeId, () =>
      prisma.order.update({
        where: { id: orderId },
        data: { customerNotes: 'rls-context-write' },
      })
    );
    expect(updated.customerNotes).toBe('rls-context-write');

    // Reset
    await runInTenantContext(storeId, () =>
      prisma.order.update({ where: { id: orderId }, data: { customerNotes: null } })
    );
  });
});
