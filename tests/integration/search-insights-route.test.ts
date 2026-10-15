/**
 * GET /stores/:storeId/search-insights (search program P0, Task 6).
 *
 * The real router, mounted the way routes/index.ts mounts it, on the guarded `ebda_app` client
 * bound per request (strict RLS + tenant guard), with the auth chain stubbed so the TEST can
 * also assert the chain's order (authenticate → MFA → authorize(store_admin, super_admin) →
 * requireStoreAccess). Rows are written through `recordSearch` (the real writer) and read
 * through the route, so the privacy floor (a term is listed only when searched ≥ 2 times in the
 * window; totals count every search) is proven end to end. Every fixture is per CALL.
 */
import crypto from 'crypto';
import { describe, it, expect, afterAll, beforeEach, vi } from 'vitest';
import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';
import { prisma, createPrismaClient, runWithRequestDb } from '@ebda/database';
import { hasDb } from '../helpers/bundle-fixtures';

const calls: string[] = [];
vi.mock('@api/middleware/auth', () => ({
  authenticate: (req: any, _res: any, next: any) => {
    calls.push('authenticate');
    req.user = { userId: 'admin-1', role: 'store_admin' };
    next();
  },
  authorize:
    (...roles: string[]) =>
    (_req: any, _res: any, next: any) => {
      calls.push(`authorize:${roles.join(',')}`);
      next();
    },
}));
vi.mock('@api/middleware/require-mfa', () => ({
  requireMfaEnrolled: (_req: any, _res: any, next: any) => {
    calls.push('mfa');
    next();
  },
}));
vi.mock('@api/middleware/store-access', () => ({
  requireStoreAccess: (_req: any, _res: any, next: any) => {
    calls.push('storeAccess');
    next();
  },
}));
vi.mock('../../apps/api/src/lib/inngest/client', () => ({
  inngest: { send: vi.fn(async () => ({ ids: [] })), createFunction: vi.fn(() => ({})) },
}));

const { awaitDeferredWork } = await import('../../apps/api/src/lib/after-tenant-commit');
const { errorHandler } = await import('../../apps/api/src/middleware/error-handler');
const { default: searchInsightsRoutes } =
  await import('../../apps/api/src/routes/search-insights.routes');
const { recordSearch } = await import('../../apps/api/src/services/search-log.service');

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

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, res: Response, next: NextFunction) => {
    asApp(
      () =>
        new Promise<void>(resolve => {
          res.once('finish', resolve);
          res.once('close', resolve);
          next();
        })
    ).catch(next);
  });
  app.use('/api/v1/stores', searchInsightsRoutes);
  app.use(errorHandler);
  return app;
}

const created = { storeIds: [] as string[], userIds: [] as string[] };
const uid = () => crypto.randomUUID().slice(0, 12);

async function seedStore(tag: string): Promise<string> {
  const id = uid();
  const owner = await prisma.user.create({
    data: {
      email: `si-${tag}-${id}@test.local`,
      passwordHash: 'x',
      firstName: 'Search',
      lastName: 'Insights',
      role: 'store_admin',
      status: 'active',
      emailVerified: true,
    },
  });
  created.userIds.push(owner.id);
  const store = await prisma.store.create({
    data: {
      name: `si ${tag} ${id}`,
      slug: `si-${tag}-${id}`,
      ownerId: owner.id,
      status: 'active',
      currency: 'EGP',
    },
  });
  created.storeIds.push(store.id);
  return store.id;
}

beforeEach(() => {
  calls.length = 0;
});

afterAll(async () => {
  if (!hasDb) return;
  await prisma.searchQueryDaily.deleteMany({ where: { storeId: { in: created.storeIds } } });
  await prisma.store.deleteMany({ where: { id: { in: created.storeIds } } });
  await prisma.user.deleteMany({ where: { id: { in: created.userIds } } });
});

describe.skipIf(!hasDb)('GET /stores/:storeId/search-insights', () => {
  const app = buildApp();
  const get = (storeId: string, qs: string) =>
    request(app).get(`/api/v1/stores/${storeId}/search-insights${qs}`);

  it('returns a null rate and no terms when nothing was searched (unknown is never 0%)', async () => {
    const emptyStoreId = await seedStore('empty');
    const res = await get(emptyStoreId, '?days=30');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      days: 30,
      totals: { searches: 0, zeroResultSearches: 0, zeroResultRate: null },
      terms: [],
    });
  });

  it('lists zero-result terms first, behind the ≥2 floor, with totals counting every search', async () => {
    const storeId = await seedStore('zero');
    await asApp(() => recordSearch(storeId, 'كوتشي', 0));
    await asApp(() => recordSearch(storeId, 'كوتشي', 0));
    await asApp(() => recordSearch(storeId, 'تيشرت', 5));
    await asApp(() => recordSearch(storeId, 'بنطلون', 0)); // one-off: below the floor

    const res = await get(storeId, '?days=30&filter=zero');
    expect(res.status).toBe(200);
    expect(res.body.data.terms).toEqual([
      { term: 'كوتشي', searches: 2, zeroResults: 2, lastResultCount: 0 },
    ]);
    expect(res.body.data.totals.searches).toBe(4);
    expect(res.body.data.totals.zeroResultSearches).toBe(3);
    expect(res.body.data.totals.zeroResultRate).toBeCloseTo(3 / 4);

    // The default filter is 'zero' and the default window is 30 days.
    const dflt = await get(storeId, '');
    expect(dflt.body.data.days).toBe(30);
    expect(dflt.body.data.terms.map((t: { term: string }) => t.term)).toEqual(['كوتشي']);
  });

  it("filter=all lists searched terms too and keeps a term's searches on non-zero days", async () => {
    const storeId = await seedStore('all');
    await asApp(() => recordSearch(storeId, 'تيشرت', 5));
    await asApp(() => recordSearch(storeId, 'تيشرت', 0));
    const all = await get(storeId, '?days=7&filter=all');
    expect(all.body.data.terms).toEqual([
      { term: 'تيشرت', searches: 2, zeroResults: 1, lastResultCount: 0 },
    ]);
    // 'zero' keeps the term but still reports ALL its searches (not only the zero-result ones).
    const zero = await get(storeId, '?days=7&filter=zero');
    expect(zero.body.data.terms[0]).toMatchObject({ searches: 2, zeroResults: 1 });
  });

  it('is store-isolated', async () => {
    const a = await seedStore('iso-a');
    const b = await seedStore('iso-b');
    await asApp(() => recordSearch(a, 'كوتشي', 0));
    await asApp(() => recordSearch(a, 'كوتشي', 0));
    const res = await get(b, '?days=90&filter=all');
    expect(res.body.data.terms).toEqual([]);
    expect(res.body.data.totals.searches).toBe(0);
  });

  it.each(['?days=400', '?days=0', '?days=abc', '?days=30&filter=bogus'])(
    'rejects %s with 400',
    async qs => {
      const storeId = await seedStore('bad');
      const res = await get(storeId, qs);
      expect(res.status).toBe(400);
    }
  );

  it('runs authenticate → MFA → authorize(store_admin, super_admin) → requireStoreAccess, in that order', async () => {
    const storeId = await seedStore('chain');
    await get(storeId, '?days=7');
    expect(calls).toEqual([
      'authenticate',
      'mfa',
      'authorize:store_admin,super_admin',
      'storeAccess',
    ]);
  });
});
