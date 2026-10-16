/**
 * The k≥2 floor counts DISTINCT searchers, not requests (Ruling SEARCH-T5-6, revised 2026-10-16;
 * PR 1 final review I2).
 *
 * The storefront search page re-fetches page 1 of the same term when the shopper changes the
 * sort or the category, and on the retry button. Each of those is a request, not a new search:
 * a shopper who typed a name once and re-sorted must not clear the floor alone. The dedupe is a
 * salted, daily-rotated HMAC of (IP + user agent) kept ONLY as a short-lived Redis key; it is
 * never stored in `search_query_daily` or logged. Redis down → fail-open, the request counts.
 *
 * Real Redis (REDIS_URL), the real public router behind `publicStoreContext`, the guarded app
 * client on `ebda_app` (strict RLS), the write deferred after the request commits. Every
 * fixture is per CALL (retry-safe: a fresh store per test, so Redis keys never carry over).
 */
import crypto from 'crypto';
import { describe, it, expect, afterAll, beforeAll, vi } from 'vitest';
import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';
import { prisma, createPrismaClient, runWithRequestDb } from '@ebda/database';
import { hasDb } from '../helpers/bundle-fixtures';

vi.mock('../../apps/api/src/lib/inngest/client', () => ({
  inngest: { send: vi.fn(async () => ({ ids: [] })), createFunction: vi.fn(() => ({})) },
}));
const { awaitDeferredWork } = await import('../../apps/api/src/lib/after-tenant-commit');
const { default: publicRoutes } = await import('../../apps/api/src/routes/public.routes');
const { publicStoreContext } = await import('../../apps/api/src/middleware/tenant-context');
const { errorHandler } = await import('../../apps/api/src/middleware/error-handler');
const { redis } = await import('../../apps/api/src/services/redis.service');
const { default: logger } = await import('../../apps/api/src/lib/logger');
const {
  getSearchInsights,
  searcherDedupeKey,
  SEARCH_LOG_SEARCHER_DEDUPE_TTL_S,
  SEARCH_LOG_MIN_SEARCHES_SHOWN,
} = await import('../../apps/api/src/services/search-log.service');

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
  // One proxy hop, as in app.ts: X-Forwarded-For names the searcher's IP.
  app.set('trust proxy', 1);
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
  app.use('/api/v1/public', publicStoreContext);
  app.use('/api/v1/public', publicRoutes);
  app.use(errorHandler);
  return app;
}

const created = { storeIds: [] as string[], userIds: [] as string[] };
const uid = () => crypto.randomUUID().slice(0, 12);

async function seedStore(tag: string): Promise<string> {
  const id = uid();
  const owner = await prisma.user.create({
    data: {
      email: `sld-${tag}-${id}@test.local`,
      passwordHash: 'x',
      firstName: 'Search',
      lastName: 'Dedupe',
      role: 'store_admin',
      status: 'active',
      emailVerified: true,
    },
  });
  created.userIds.push(owner.id);
  const store = await prisma.store.create({
    data: {
      name: `sld ${tag} ${id}`,
      slug: `sld-${tag}-${id}`,
      ownerId: owner.id,
      status: 'active',
      currency: 'EGP',
    },
  });
  created.storeIds.push(store.id);
  return store.id;
}

const app = buildApp();
type Searcher = { ip: string; userAgent: string };
const searcher = (): Searcher => ({
  ip: `10.${crypto.randomInt(1, 250)}.${crypto.randomInt(1, 250)}.${crypto.randomInt(1, 250)}`,
  userAgent: `Mozilla/5.0 dedupe-test/${uid()}`,
});
async function search(storeId: string, who: Searcher, qs: string) {
  const res = await request(app)
    .get(`/api/v1/public/products?${qs}`)
    .set('x-store-id', storeId)
    .set('x-forwarded-for', who.ip)
    .set('user-agent', who.userAgent);
  await awaitDeferredWork(5000);
  expect(res.status).toBe(200);
}
const searchesOf = async (storeId: string) =>
  (await prisma.searchQueryDaily.findMany({ where: { storeId } })).map(r => [r.term, r.searches]);
const listed = (storeId: string) =>
  asApp(() => getSearchInsights(storeId, { days: 7, filter: 'all' })).then(r =>
    r.terms.map(t => [t.term, t.searches])
  );

beforeAll(async () => {
  if (!hasDb) return;
  await redis.connect();
  expect(redis.isAvailable()).toBe(true);
});

afterAll(async () => {
  if (!hasDb) return;
  await prisma.searchQueryDaily.deleteMany({ where: { storeId: { in: created.storeIds } } });
  await prisma.store.deleteMany({ where: { id: { in: created.storeIds } } });
  await prisma.user.deleteMany({ where: { id: { in: created.userIds } } });
  await redis.disconnect();
});

describe.skipIf(!hasDb)('distinct-searcher counting (real Redis, ebda_app)', () => {
  it('one searcher sorting, filtering and retrying counts once and stays under the floor', async () => {
    const storeId = await seedStore('one');
    const who = searcher();
    const q = encodeURIComponent('احمد محمد حسن');
    await search(storeId, who, `search=${q}`); // typed
    await search(storeId, who, `search=${q}&sort=price_asc`); // sort change
    await search(storeId, who, `search=${q}&category=${crypto.randomUUID()}`); // category change
    await search(storeId, who, `search=${q}&page=1`); // retry
    await search(storeId, who, `search=${encodeURIComponent('أحمد  محمد حسن')}`); // spelling variant
    expect(await searchesOf(storeId)).toEqual([['احمد محمد حسن', 1]]);
    expect(SEARCH_LOG_MIN_SEARCHES_SHOWN).toBe(2);
    expect(await listed(storeId)).toEqual([]);
  });

  it('two searchers count 2 and the term becomes visible in insights', async () => {
    const storeId = await seedStore('two');
    const a = searcher();
    const b = searcher();
    const q = encodeURIComponent('كوتشي ابيض');
    await search(storeId, a, `search=${q}`);
    await search(storeId, a, `search=${q}&sort=newest`);
    await search(storeId, b, `search=${q}`);
    await search(storeId, b, `search=${q}`);
    expect(await searchesOf(storeId)).toEqual([['كوتشي ابيض', 2]]);
    expect(await listed(storeId)).toEqual([['كوتشي ابيض', 2]]);
  });

  it('same IP with a different user agent, or a different IP, is another searcher', async () => {
    const storeId = await seedStore('ipua');
    const a = searcher();
    const q = encodeURIComponent('فستان');
    await search(storeId, a, `search=${q}`);
    await search(storeId, { ...a, userAgent: `${a.userAgent} other` }, `search=${q}`);
    await search(storeId, { ...a, ip: '10.251.0.1' }, `search=${q}`);
    expect(await searchesOf(storeId)).toEqual([['فستان', 3]]);
  });

  it('the Redis key is a hex digest only (no IP, user agent or term) with a 30-minute TTL', async () => {
    const storeId = await seedStore('key');
    const who = searcher();
    await search(storeId, who, `search=${encodeURIComponent('شنطة')}`);
    const key = searcherDedupeKey(storeId, 'شنطه', who);
    expect(key).toMatch(/^search-log:seen:[0-9a-f]{64}$/);
    for (const part of [who.ip, who.userAgent, 'شنطه', storeId]) expect(key).not.toContain(part);
    const ttl = await redis.getClient()!.ttl(key);
    expect(ttl).toBeGreaterThan(120);
    expect(ttl).toBeLessThanOrEqual(SEARCH_LOG_SEARCHER_DEDUPE_TTL_S);
    expect(SEARCH_LOG_SEARCHER_DEDUPE_TTL_S).toBe(1800);
    // Daily rotation: the same searcher hashes differently on another Cairo day.
    const tomorrow = new Date(Date.now() + 86_400_000);
    expect(searcherDedupeKey(storeId, 'شنطه', who, tomorrow)).not.toBe(key);
  });

  it('fail-open: Redis down counts every request once, never blocks the search, never logs the term', async () => {
    const storeId = await seedStore('down');
    const who = searcher();
    const warn = vi.spyOn(logger, 'warn');
    const getClient = vi.spyOn(redis, 'getClient').mockReturnValue({
      set: async () => {
        throw Object.assign(new Error('redis down'), { code: 'ECONNREFUSED' });
      },
    } as never);
    try {
      const q = encodeURIComponent('جزمة سوداء');
      await search(storeId, who, `search=${q}`);
      await search(storeId, who, `search=${q}&sort=price_desc`);
      expect(await searchesOf(storeId)).toEqual([['جزمه سوداء', 2]]);
      const logged = JSON.stringify(warn.mock.calls);
      expect(logged).toContain('[SEARCH-LOG] searcher dedupe unavailable');
      expect(logged).not.toContain('سوداء');
      expect(logged).not.toContain(who.ip);
    } finally {
      getClient.mockRestore();
      warn.mockRestore();
    }
  });
});
