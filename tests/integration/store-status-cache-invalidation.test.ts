/**
 * Store-status cache invalidation (adversarial audit P1-7).
 *
 * PATCH /stores/:id/status wrote `store.status` and invalidated ONLY the
 * feature cache — never `public:store:resolve:<domain>` /
 * `public:store:<slug>` / `public:store:<id>` (the caches that carry the
 * `status` field the storefront 503-gates on), and never the storefront
 * revalidate purge. A suspended (fraud / non-payment) store kept serving
 * the full active storefront — checkouts included — for up to the TTL.
 * Account status is a NEVER-stale value: every write path must invalidate
 * every layer (global rule feedback-cache-invalidate-every-write-path).
 *
 * Fix under test: the status PATCH busts the store resolve/slug/id caches
 * via the same helper the domain-change path uses.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.mock('@api/middleware/auth', () => ({
  rejectImpersonated: (_q: any, _s: any, n: any) => n(),
  authenticate: (req: { user?: unknown }, _res: unknown, next: () => void) => {
    (req as { user: unknown }).user = { userId: 'test-super', role: 'super_admin' };
    next();
  },
  authorize:
    (..._roles: string[]) =>
    (_req: unknown, _res: unknown, next: () => void) =>
      next(),
  optionalAuthenticate: (_req: unknown, _res: unknown, next: () => void) => next(),
  customerUserId: () => undefined,
}));
vi.mock('@api/middleware/require-mfa', () => ({
  requireMfaEnrolled: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('@api/middleware/store-access', () => ({
  requireStoreAccess: (_req: unknown, _res: unknown, next: () => void) => next(),
  checkStoreAccess: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import express from 'express';
import request from 'supertest';
import { withRlsBypass } from '@ebda/database';
import storeRoutes from '@api/routes/store.routes';
import { getCached } from '@api/lib/public-cache';

const hasDb =
  !!process.env.DATABASE_URL && !process.env.DATABASE_URL.includes('localhost:5432/test_db');

const app = express();
app.use(express.json());
app.use('/api/v1/stores', storeRoutes);

describe.skipIf(!hasDb)('store status PATCH — cache invalidation', () => {
  const suffix = `${Date.now()}-${process.pid}-${Math.random().toString(36).substring(7)}`;
  const slug = `ssc-test-${suffix}`;
  const domain = `ssc-${suffix}.example.test`;
  let storeId: string;

  beforeAll(async () => {
    await withRlsBypass(async tx => {
      const owner = await tx.user.create({
        data: {
          email: `ssc-owner-${suffix}@example.com`,
          passwordHash: 'not-a-real-hash',
          role: 'store_admin',
          firstName: 'SSC',
          lastName: 'Owner',
        },
      });
      const store = await tx.store.create({
        data: {
          name: 'ssc-test-store',
          slug,
          domain,
          template: 'qamar',
          currency: 'EGP',
          ownerId: owner.id,
          status: 'active',
        },
      });
      storeId = store.id;
    });
  });

  afterAll(async () => {
    await withRlsBypass(async tx => {
      await tx.auditLog.deleteMany({ where: { storeId } }).catch(() => {});
      await tx.store.deleteMany({ where: { id: storeId } }).catch(() => {});
      await tx.user.deleteMany({ where: { email: { contains: suffix } } }).catch(() => {});
    });
  });

  it('suspending a store busts the resolve/slug/id public caches', async () => {
    // Prime the three cache keys the storefront reads status through.
    const keys = [
      `public:store:resolve:${domain}`,
      `public:store:${slug}`,
      `public:store:${storeId}`,
    ];
    for (const key of keys) {
      await getCached(key, 120, async () => ({ status: 'active', primed: true }));
    }
    // Sanity: the entries are actually cached (fetcher not re-run).
    for (const key of keys) {
      const cached = (await getCached(key, 120, async () => ({ status: 'MISS' }))) as {
        status: string;
      };
      expect(cached.status).toBe('active');
    }

    const res = await request(app)
      .patch(`/api/v1/stores/${storeId}/status`)
      .send({ status: 'suspended' });
    expect(res.status).toBe(200);

    // Every primed key must now MISS — a suspended store must not keep
    // serving the cached active resolve for up to the TTL.
    for (const key of keys) {
      const after = (await getCached(key, 120, async () => ({ status: 'MISS' }))) as {
        status: string;
      };
      expect(after.status).toBe('MISS');
    }

    const row = await withRlsBypass(tx =>
      tx.store.findUniqueOrThrow({ where: { id: storeId }, select: { status: true } })
    );
    expect(row.status).toBe('suspended');
  });
});
