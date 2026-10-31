/**
 * Storefront search log (search program P0, Task 5): `search_query_daily`.
 *
 * Everything runs the way production runs it: the guarded app client (`createPrismaClient`,
 * tenant guard R-EBDA-003/004) on the strict-RLS role `ebda_app` (R-EBDA-001), bound with
 * `runWithRequestDb`. The HTTP cases mount `publicStoreContext` + the public router exactly as
 * `routes/index.ts` does, so the write goes through `deferAfterTenantCommit` after the GET's
 * request transaction commits (E2). Owner-role `prisma` is used only for fixtures and
 * read-backs. Every fixture is per CALL (retry-safe).
 */
import crypto from 'crypto';
import { describe, it, expect, afterAll, vi } from 'vitest';
import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';
import { prisma, createPrismaClient, runWithRequestDb } from '@ebda/database';
import { REGION, zonedIsoDay } from '@ebda/shared';
import { configureIdentityClient } from '@api/lib/identity-client';
import { hasDb } from '../helpers/bundle-fixtures';

vi.mock('../../apps/api/src/lib/inngest/client', () => ({
  inngest: { send: vi.fn(async () => ({ ids: [] })), createFunction: vi.fn(() => ({})) },
}));
const { awaitDeferredWork } = await import('../../apps/api/src/lib/after-tenant-commit');
const { default: publicRoutes } = await import('../../apps/api/src/routes/public.routes');
const { publicStoreContext } = await import('../../apps/api/src/middleware/tenant-context');
const { errorHandler } = await import('../../apps/api/src/middleware/error-handler');
const { default: logger } = await import('../../apps/api/src/lib/logger');
const { StoreService } = await import('../../apps/api/src/services/store.service');
const { recordSearch, purgeSearchLog, purgeSearchLogAcrossStores, getSearchInsights, isoDayMinus } =
  await import('../../apps/api/src/services/search-log.service');
const { requestLogger } = await import('../../apps/api/src/middleware/request-logger');

const OWNER_URL = process.env.DIRECT_URL || process.env.DATABASE_URL || '';
function appUrl(): string {
  const u = new URL(OWNER_URL);
  u.username = 'ebda_app';
  u.password = process.env.EBDA_APP_PASSWORD || 'ci-only-app-pw';
  return u.toString();
}
/** Run `fn` on the guarded ebda_app client with NO ambient tenant context (the deferred drain's shape). */
const asApp = <T>(fn: () => Promise<T>) =>
  runWithRequestDb(() => createPrismaClient({ connectionString: appUrl(), max: 3 }), fn, {
    beforeDisconnect: () => awaitDeferredWork(5000),
  });

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  // The API's own access log (app.ts mounts it on every request).
  app.use(requestLogger);
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
  app.use('/api/v1/public', publicStoreContext);
  app.use('/api/v1/public', publicRoutes);
  app.use(errorHandler);
  return app;
}

const created = { storeIds: [] as string[], userIds: [] as string[] };
const uid = () => crypto.randomUUID().slice(0, 12);
const today = () => zonedIsoDay(new Date(), REGION.timezone);
const asDate = (day: string) => new Date(`${day}T00:00:00Z`);

async function seedStore(tag: string): Promise<string> {
  const id = uid();
  const owner = await prisma.user.create({
    data: {
      email: `sl-${tag}-${id}@test.local`,
      passwordHash: 'x',
      firstName: 'Search',
      lastName: 'Log',
      role: 'store_admin',
      status: 'active',
      emailVerified: true,
    },
  });
  created.userIds.push(owner.id);
  const store = await prisma.store.create({
    data: {
      name: `sl ${tag} ${id}`,
      slug: `sl-${tag}-${id}`,
      ownerId: owner.id,
      status: 'active',
      currency: 'EGP',
    },
  });
  created.storeIds.push(store.id);
  return store.id;
}

const rowsOf = (storeId: string) =>
  prisma.searchQueryDaily.findMany({ where: { storeId }, orderBy: { term: 'asc' } });

afterAll(async () => {
  if (!hasDb) return;
  await prisma.auditLog.deleteMany({ where: { userId: { in: created.userIds } } });
  await prisma.product.deleteMany({ where: { storeId: { in: created.storeIds } } });
  await prisma.searchQueryDaily.deleteMany({ where: { storeId: { in: created.storeIds } } });
  await prisma.store.deleteMany({ where: { id: { in: created.storeIds } } });
  await prisma.user.deleteMany({ where: { id: { in: created.userIds } } });
});

describe.skipIf(!hasDb)('recordSearch on ebda_app (guard + strict RLS)', () => {
  it('aggregates spelling variants into one normalised row on the Cairo day and counts zero results', async () => {
    const storeId = await seedStore('agg');
    expect(await asApp(() => recordSearch(storeId, 'أحذية', 0))).toBe(true);
    expect(await asApp(() => recordSearch(storeId, ' احذيه ', 3))).toBe(true);
    const rows = await rowsOf(storeId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      term: 'احذيه',
      searches: 2,
      zeroResults: 1,
      lastResultCount: 3,
    });
    // DATE column holds the Cairo calendar day (not the UTC day of Cairo midnight).
    expect(rows[0].date.toISOString().slice(0, 10)).toBe(today());
    // No exact search time is kept: updated_at is the day only (Ruling SEARCH-T5-6).
    expect(rows[0].updatedAt.toISOString()).toBe(`${today()}T00:00:00.000Z`);
  });

  it('never stores a phone, an email, an order number or an id, in any digit script', async () => {
    const storeId = await seedStore('pii');
    for (const t of [
      '٠١٠١٢٣٤٥٦٧٨',
      '+20 101 234 5678',
      'ahmed@example.com',
      'ORD-TQX2P9-7A3FQ',
      '29801011234567',
      '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
    ]) {
      expect(await asApp(() => recordSearch(storeId, t, 0))).toBe(false);
    }
    expect(await prisma.searchQueryDaily.count({ where: { storeId } })).toBe(0);
  });

  it('caps distinct terms per store per day; known terms keep counting', async () => {
    const storeId = await seedStore('cap');
    const cap = { maxTermsPerDay: 2 };
    expect(await asApp(() => recordSearch(storeId, 'كوتشي', 1, cap))).toBe(true);
    expect(await asApp(() => recordSearch(storeId, 'تيشرت', 1, cap))).toBe(true);
    expect(await asApp(() => recordSearch(storeId, 'بنطلون', 1, cap))).toBe(false);
    expect(await asApp(() => recordSearch(storeId, 'كوتشي', 0, cap))).toBe(true);
    const rows = await rowsOf(storeId);
    expect(rows.map(r => [r.term, r.searches])).toEqual([
      ['تيشرت', 1],
      ['كوتشي', 2],
    ]);
  });

  it('is fail-open and never logs the term', async () => {
    const warn = vi.spyOn(logger, 'warn');
    try {
      // A store that does not exist: the FK rejects the insert.
      const ghost = crypto.randomUUID();
      expect(await asApp(() => recordSearch(ghost, 'فستان سهرة', 0))).toBe(false);
      const logged = JSON.stringify(warn.mock.calls);
      expect(logged).toContain('[SEARCH-LOG]');
      expect(logged).not.toContain('فستان');
      expect(logged).not.toContain('فستان سهرة');
    } finally {
      warn.mockRestore();
    }
  });
});

describe.skipIf(!hasDb)('GET /public/products logs through the real HTTP path', () => {
  const app = buildApp();
  // A fresh user agent per request: each call is a different searcher, so the distinct-searcher
  // dedupe (Ruling SEARCH-T5-6, covered in search-log-distinct-searchers.test.ts) never merges
  // them whether or not Redis is up.
  const get = async (storeId: string, qs: string) => {
    const res = await request(app)
      .get(`/api/v1/public/products?${qs}`)
      .set('x-store-id', storeId)
      .set('user-agent', `search-log-test/${uid()}`);
    await awaitDeferredWork(5000);
    return res;
  };

  it('counts page 1 of a real query (cached hits included), after the response', async () => {
    const storeId = await seedStore('http');
    const q = encodeURIComponent('أحذية');
    expect((await get(storeId, `search=${q}`)).status).toBe(200);
    expect((await get(storeId, `search=${encodeURIComponent('احذيه')}`)).status).toBe(200);
    expect((await get(storeId, `search=${q}&page=1`)).status).toBe(200);
    const rows = await rowsOf(storeId);
    expect(rows.map(r => [r.term, r.searches, r.zeroResults])).toEqual([['احذيه', 3, 3]]);
  });

  it('does not count paging, cursors, sub-floor terms, typeahead or a phone', async () => {
    const storeId = await seedStore('skip');
    const q = encodeURIComponent('كوتشي');
    expect((await get(storeId, `search=${q}&page=2`)).status).toBe(200);
    expect((await get(storeId, `search=${q}&cursor=${crypto.randomUUID()}`)).status).toBe(200);
    expect((await get(storeId, 'search=a')).status).toBe(200);
    expect((await get(storeId, `search=${encodeURIComponent('٠١٠١٢٣٤٥٦٧٨')}`)).status).toBe(200);
    const suggest = await request(app).get(`/api/v1/public/${storeId}/search/suggest?q=${q}`);
    await awaitDeferredWork(5000);
    expect(suggest.status).toBeLessThan(500);
    expect(await prisma.searchQueryDaily.count({ where: { storeId } })).toBe(0);
  });

  it('a phone in ?search= never reaches any log line of the request (access log included)', async () => {
    const storeId = await seedStore('nolog');
    const spies = (['info', 'warn', 'error', 'debug'] as const).map(l => vi.spyOn(logger, l));
    try {
      for (const phone of ['01012345678', '٠١٠١٢٣٤٥٦٧٨', '010–1234–5678']) {
        const res = await get(storeId, `search=${encodeURIComponent(phone)}`);
        expect(res.status).toBe(200);
        const logged = JSON.stringify(spies.map(s => s.mock.calls));
        expect(logged).toContain('/products'); // the access log line ran (path, no query)
        expect(logged).not.toContain(phone);
        expect(logged).not.toContain(encodeURIComponent(phone));
      }
      expect(await prisma.searchQueryDaily.count({ where: { storeId } })).toBe(0);
    } finally {
      spies.forEach(s => s.mockRestore());
    }
  });

  it("records the real result count and never another store's", async () => {
    const storeId = await seedStore('count');
    const other = await seedStore('other');
    const run = uid();
    await prisma.product.create({
      data: {
        storeId,
        slug: `sneaker-${run}`,
        name: `sneaker ${run}`,
        price: 1000,
        inventory: 3,
        status: 'active',
      },
    });
    expect((await get(storeId, `search=sneaker`)).status).toBe(200);
    expect((await rowsOf(storeId)).map(r => [r.term, r.lastResultCount, r.zeroResults])).toEqual([
      ['sneaker', 1, 0],
    ]);
    expect(await prisma.searchQueryDaily.count({ where: { storeId: other } })).toBe(0);
  });
});

describe.skipIf(!hasDb)('read API, retention and erasure', () => {
  it('getSearchInsights: zero-result terms first, all-searches mode, null rate when empty, store-isolated', async () => {
    const storeId = await seedStore('ins');
    const empty = await seedStore('ins-empty');
    await asApp(() => recordSearch(storeId, 'كوتشي', 0));
    await asApp(() => recordSearch(storeId, 'كوتشي', 0));
    await asApp(() => recordSearch(storeId, 'تيشرت', 5));

    const zero = await asApp(() => getSearchInsights(storeId, { days: 30, filter: 'zero' }));
    expect(zero.terms).toEqual([
      { term: 'كوتشي', searches: 2, zeroResults: 2, lastResultCount: 0 },
    ]);
    expect(zero.totals.searches).toBe(3);
    expect(zero.totals.zeroResultSearches).toBe(2);
    expect(zero.totals.zeroResultRate).toBeCloseTo(2 / 3);

    // k-anonymity floor: 'تيشرت' was searched once, so it is counted in the totals but never
    // listed (a one-off pasted name or address never shows; Ruling SEARCH-T5-6).
    const all = await asApp(() => getSearchInsights(storeId, { days: 7, filter: 'all' }));
    expect(all.terms.map(t => t.term)).toEqual(['كوتشي']);
    expect(all.totals.searches).toBe(3);
    await asApp(() => recordSearch(storeId, 'تيشرت', 5));
    const again = await asApp(() => getSearchInsights(storeId, { days: 7, filter: 'all' }));
    // Equal searches: ties break on the term (ت sorts before ك).
    expect(again.terms.map(t => [t.term, t.searches])).toEqual([
      ['تيشرت', 2],
      ['كوتشي', 2],
    ]);

    const none = await asApp(() => getSearchInsights(empty, { days: 90, filter: 'all' }));
    expect(none).toEqual({
      days: 90,
      totals: { searches: 0, zeroResultSearches: 0, zeroResultRate: null },
      terms: [],
    });
  });

  it('getSearchInsights: window is the last N Cairo days; lastResultCount is the newest day', async () => {
    const storeId = await seedStore('win');
    const t = today();
    await prisma.searchQueryDaily.createMany({
      data: [
        {
          storeId,
          date: asDate(isoDayMinus(t, 6)),
          term: 'جاكيت',
          searches: 4,
          zeroResults: 4,
          lastResultCount: 0,
        },
        {
          storeId,
          date: asDate(t),
          term: 'جاكيت',
          searches: 1,
          zeroResults: 0,
          lastResultCount: 7,
        },
        {
          storeId,
          date: asDate(isoDayMinus(t, 7)),
          term: 'قديم',
          searches: 9,
          zeroResults: 9,
          lastResultCount: 0,
        },
      ],
    });
    const r = await asApp(() => getSearchInsights(storeId, { days: 7, filter: 'zero' }));
    // Counts ALL the term's searches in the window, not only its zero-result days.
    expect(r.terms).toEqual([{ term: 'جاكيت', searches: 5, zeroResults: 4, lastResultCount: 7 }]);
    expect(r.totals).toMatchObject({ searches: 5, zeroResultSearches: 4 });
  });

  it('purgeSearchLog drops rows older than 90 Cairo days, for this store only', async () => {
    const storeId = await seedStore('purge');
    const other = await seedStore('purge-other');
    const t = today();
    const mk = (s: string, ago: number) => ({
      storeId: s,
      date: asDate(isoDayMinus(t, ago)),
      term: `t${ago}`,
      searches: 1,
    });
    await prisma.searchQueryDaily.createMany({
      data: [mk(storeId, 91), mk(storeId, 90), mk(storeId, 0), mk(other, 200)],
    });
    expect(await asApp(() => purgeSearchLog(storeId))).toBe(1);
    expect((await rowsOf(storeId)).map(r => r.term)).toEqual(['t0', 't90']);
    expect(await prisma.searchQueryDaily.count({ where: { storeId: other } })).toBe(1);
  });

  it('the purge sweep carries on past a failing store and reports it (store id + code only)', async () => {
    const storeId = await seedStore('sweep');
    const t = today();
    await prisma.searchQueryDaily.createMany({
      data: [
        { storeId, date: asDate(isoDayMinus(t, 120)), term: 'قديم جدا', searches: 1 },
        { storeId, date: asDate(t), term: 'جديد', searches: 1 },
      ],
    });
    const err = vi.spyOn(logger, 'error');
    try {
      // A store id the tenant scope refuses: its purge throws; the next store must still run.
      const res = await asApp(() =>
        purgeSearchLogAcrossStores({ storeIds: ['not-a-store-id', storeId] })
      );
      expect(res).toEqual({ purged: 1, failedStores: 1 });
      expect((await rowsOf(storeId)).map(r => r.term)).toEqual(['جديد']);
      const logged = JSON.stringify(err.mock.calls);
      expect(logged).toContain('not-a-store-id');
      expect(logged).toContain('[SEARCH-LOG] purge failed');
      expect(logged).not.toContain('قديم');
    } finally {
      err.mockRestore();
    }
  });

  it('store deletion removes the store search log (FK cascade)', async () => {
    const storeId = await seedStore('del');
    await asApp(() => recordSearch(storeId, 'شنطه', 0));
    expect(await prisma.searchQueryDaily.count({ where: { storeId } })).toBe(1);
    const operator = await prisma.user.create({
      data: {
        email: `sl-op-${uid()}@test.local`,
        passwordHash: 'x',
        firstName: 'Op',
        lastName: 'Erator',
        role: 'super_admin',
      },
    });
    created.userIds.push(operator.id);
    // Deleting a store flips its identity-managed owner at the identity service (store.service.ts); the Postgres tier has no
    // ACCOUNTS binding, so answer as the service would for an active account.
    configureIdentityClient({
      getAccountState: async () => ({ status: 'active' }) as never,
      setStatus: async () => undefined,
      revokeUser: async () => undefined,
      deleteStoreClients: async () => ({ clients: 0 }),
    });
    try {
      await StoreService.delete(storeId, operator.id);
    } finally {
      configureIdentityClient(undefined);
    }
    expect(await prisma.store.count({ where: { id: storeId } })).toBe(0);
    expect(await prisma.searchQueryDaily.count({ where: { storeId } })).toBe(0);
  });
});
