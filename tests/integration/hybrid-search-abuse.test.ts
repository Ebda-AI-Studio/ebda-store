/**
 * Search program Task 12, Ruling SEARCH-T12-3: anonymous storefront search must not be a way to
 * spend Workers AI. 1000 UNIQUE queries (each one a cache miss) from ONE client through the real
 * public router make at most SEARCH_EMBED_PER_SEARCHER_PER_MIN provider calls, and every response
 * is an answer (200, or the pre-existing per-IP 429 of `publicLimiter`), never a 500. A second
 * client is still served semantic results (the limit is per searcher, not global).
 * Real Redis (REDIS_URL) for the limiter + budgets; the guarded app client on `ebda_app`.
 */
import crypto from 'crypto';
import { describe, it, expect, afterAll, beforeAll, vi } from 'vitest';
import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';
import { prisma, createPrismaClient, runWithRequestDb } from '@ebda/database';
import { hasDb } from '../helpers/bundle-fixtures';
import { fakeVector } from '../helpers/fake-embeddings';

vi.mock('../../apps/api/src/lib/inngest/client', () => ({
  inngest: { send: vi.fn(async () => ({ ids: [] })), createFunction: vi.fn(() => ({})) },
}));
const { awaitDeferredWork } = await import('../../apps/api/src/lib/after-tenant-commit');
const { default: publicRoutes } = await import('../../apps/api/src/routes/public.routes');
const { publicStoreContext } = await import('../../apps/api/src/middleware/tenant-context');
const { errorHandler } = await import('../../apps/api/src/middleware/error-handler');
const { redis } = await import('../../apps/api/src/services/redis.service');
const { SEARCH_EMBED_PER_SEARCHER_PER_MIN } =
  await import('../../apps/api/src/middleware/security');
const { setEmbeddingProviderForTests, EMBED_MODEL } =
  await import('../../apps/api/src/lib/search/embedding-provider');
const { indexStore } = await import('../../apps/api/src/services/product-index.service');
const { runInStoreScope } = await import('@ebda/database');
const { clearQueryVectorCacheForTests } =
  await import('../../apps/api/src/services/product-search.service');

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
let storeId: string;
let target: string;
const calls: string[] = [];
const app = buildApp();
/** A unique letters-only word (digits or a UUID would make the query personal-data-shaped). */
const word = () =>
  Array.from(crypto.randomBytes(8), b => String.fromCharCode(97 + (b % 26))).join('');
const ip = () =>
  `10.${crypto.randomInt(1, 250)}.${crypto.randomInt(1, 250)}.${crypto.randomInt(1, 250)}`;

beforeAll(async () => {
  if (!hasDb) return;
  await redis.connect();
  expect(redis.isAvailable()).toBe(true);
  const id = crypto.randomUUID().slice(0, 12);
  const owner = await prisma.user.create({
    data: {
      email: `hsa-${id}@test.local`,
      passwordHash: 'x',
      firstName: 'H',
      lastName: 'A',
      role: 'store_admin',
      status: 'active',
      emailVerified: true,
    },
  });
  created.userIds.push(owner.id);
  storeId = (
    await prisma.store.create({
      data: { name: `hsa ${id}`, slug: `hsa-${id}`, ownerId: owner.id, status: 'active' },
    })
  ).id;
  created.storeIds.push(storeId);
  target = (
    await prisma.product.create({
      data: {
        storeId,
        slug: `t-${id}`,
        name: 'Sport trainer',
        nameAr: 'حذاء رياضي',
        price: 5000,
        status: 'active',
      },
    })
  ).id;
  const { embedCallBudgetKey, queryEmbedGlobalKey } =
    await import('../../apps/api/src/lib/search/embed-budget');
  await redis.getClient()?.del(embedCallBudgetKey(new Date()));
  await redis.getClient()?.del(queryEmbedGlobalKey(new Date()));
  setEmbeddingProviderForTests({
    model: EMBED_MODEL,
    embed: async (texts: string[]) => texts.map(t => fakeVector(t)),
  });
  await runInStoreScope(storeId, () => indexStore(storeId));
  const doc = (
    await prisma.$queryRaw<Array<{ doc: string }>>`
      SELECT public.ebda_product_embed_doc(name, name_ar, search_terms, description, description_ar) AS doc
        FROM products WHERE id = ${target}`
  )[0].doc;
  // Every query whose text starts with "كوتشي" embeds to the product's vector.
  setEmbeddingProviderForTests({
    model: EMBED_MODEL,
    embed: async (texts: string[]) => {
      calls.push(...texts);
      return texts.map(t => fakeVector(t.startsWith('كوتشي') ? doc : t));
    },
  });
  process.env.SEARCH_SEMANTIC_ENABLED = 'true';
  clearQueryVectorCacheForTests();
});

afterAll(async () => {
  if (!hasDb) return;
  setEmbeddingProviderForTests(undefined);
  delete process.env.SEARCH_SEMANTIC_ENABLED;
  await prisma.searchQueryDaily.deleteMany({ where: { storeId: { in: created.storeIds } } });
  await prisma.product.deleteMany({ where: { storeId: { in: created.storeIds } } });
  await prisma.store.deleteMany({ where: { id: { in: created.storeIds } } });
  await prisma.user.deleteMany({ where: { id: { in: created.userIds } } });
  await redis.disconnect();
});

describe.skipIf(!hasDb)('query-embed abuse bound (Ruling SEARCH-T12-3)', () => {
  it(
    '1000 unique queries from one client: at most the per-searcher limit of provider calls',
    { timeout: 180_000 },
    async () => {
      const attacker = ip();
      const statuses = new Map<number, number>();
      let semanticHits = 0;
      for (let i = 0; i < 1000; i++) {
        const res = await request(app)
          .get(`/api/v1/public/products?search=${encodeURIComponent(`كوتشي ${word()} ${word()}`)}`)
          .set('x-store-id', storeId)
          .set('x-forwarded-for', attacker);
        statuses.set(res.status, (statuses.get(res.status) ?? 0) + 1);
        if (
          res.status === 200 &&
          res.body.data.products.some((p: { id: string }) => p.id === target)
        )
          semanticHits++;
      }
      await awaitDeferredWork(5000);
      expect([...statuses.keys()].every(s => s === 200 || s === 429)).toBe(true);
      expect(statuses.get(200) ?? 0).toBeGreaterThanOrEqual(SEARCH_EMBED_PER_SEARCHER_PER_MIN);
      expect(calls.length).toBeLessThanOrEqual(SEARCH_EMBED_PER_SEARCHER_PER_MIN);
      expect(calls.length).toBeGreaterThan(0); // the limiter degrades; it did not just break search
      expect(semanticHits).toBe(calls.length);
      // Embedded text is capped (the route cuts the term at 100 characters).
      expect(calls.every(t => t.length <= 100)).toBe(true);

      // Another searcher is not punished for the first one's volume.
      const before = calls.length;
      const other = await request(app)
        .get(`/api/v1/public/products?search=${encodeURIComponent(`كوتشي ${word()}`)}`)
        .set('x-store-id', storeId)
        .set('x-forwarded-for', ip());
      expect(other.status).toBe(200);
      expect(other.body.data.products.map((p: { id: string }) => p.id)).toEqual([target]);
      expect(calls.length).toBe(before + 1);
    }
  );
});
