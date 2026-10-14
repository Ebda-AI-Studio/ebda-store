/**
 * Issue 2215's class — a best-effort write whose failure is SWALLOWED, running
 * inside a request's single tenant transaction. Without a savepoint the failed
 * statement aborts the whole transaction: the catch hides it, the handler
 * answers 2xx, and COMMIT silently rolls back the business write that came
 * before it. `auditLog` is the widest such writer (every admin mutation calls
 * it after its own write).
 *
 * Mutation proof: in middleware/security.ts call `prisma.auditLog.create`
 * directly (drop `withSavepoint`) → the category written first is gone after
 * the transaction and this goes red.
 *
 * Fixtures are per-CALL (retry-safe).
 */
import { describe, it, expect, afterAll } from 'vitest';
import crypto from 'crypto';
import { prisma, runInTenantContext } from '@ebda/database';
import { auditLog } from '../../apps/api/src/middleware/security';

const hasDb =
  !!process.env.DATABASE_URL && !process.env.DATABASE_URL.includes('localhost:5432/test_db');

const created: { storeIds: string[]; userIds: string[] } = { storeIds: [], userIds: [] };

afterAll(async () => {
  if (!hasDb) return;
  await prisma.category.deleteMany({ where: { storeId: { in: created.storeIds } } });
  await prisma.auditLog.deleteMany({ where: { storeId: { in: created.storeIds } } });
  await prisma.store.deleteMany({ where: { id: { in: created.storeIds } } });
  await prisma.user.deleteMany({ where: { id: { in: created.userIds } } });
});

describe.skipIf(!hasDb)(
  'a swallowed audit-log failure cannot roll back the request (issue 2215 class)',
  () => {
    it('the business write before a failing auditLog still commits', async () => {
      const uniq = crypto.randomUUID().slice(0, 12);
      const owner = await prisma.user.create({
        data: {
          email: `svp-${uniq}@test.local`,
          passwordHash: 'x',
          firstName: 'S',
          lastName: 'P',
          role: 'store_admin',
        },
      });
      const store = await prisma.store.create({
        data: { name: 'svp', slug: `svp-${uniq}`, ownerId: owner.id, status: 'active' },
      });
      created.userIds.push(owner.id);
      created.storeIds.push(store.id);

      await runInTenantContext(store.id, async () => {
        await prisma.category.create({
          data: { storeId: store.id, name: 'Kept', slug: `kept-${uniq}` },
        });
        // FK violation on audit_logs.store_id — swallowed by auditLog's catch.
        await auditLog({
          action: 'category.create',
          userId: owner.id,
          storeId: crypto.randomUUID(),
          resourceType: 'category',
        });
      });

      const kept = await prisma.category.findFirst({
        where: { storeId: store.id, slug: `kept-${uniq}` },
      });
      expect(kept).not.toBeNull();
    });
  }
);
