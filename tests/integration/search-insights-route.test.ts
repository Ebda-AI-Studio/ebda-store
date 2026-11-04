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
  rejectImpersonated: (_q: any, _s: any, n: any) => n(),
  authenticate: (req: any, _res: any, next: any) => {
    calls.push('authenticate');
    req.user = { userId: 'user-1', role: req.header('x-test-role') ?? 'store_admin' };
    next();
  },
  // rbac.ts imports it; the route no longer uses it (Ruling SEARCH-T6-1).
  authorize: () => (_req: any, _res: any, next: any) => next(),
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
// M8: a switch that makes the index-status read fail, to prove it degrades only the index line.
const indexStatusFails = { on: false };
vi.mock('../../apps/api/src/services/product-index.service', async importOriginal => {
  const real =
    await importOriginal<typeof import('../../apps/api/src/services/product-index.service')>();
  return {
    ...real,
    storeIndexStatus: async (storeId: string) => {
      if (indexStatusFails.on) throw new Error('index status read failed');
      return real.storeIndexStatus(storeId);
    },
  };
});
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
      index: { products: 0, indexed: 0, stale: 0, failed: 0, semanticEnabled: false },
    });
  });

  // Task 12: the viewer of product_embeddings (every-data-needs-UI) — "N of M ready / N failed".
  it('an index-status failure drops only the index line; the search insights still answer', async () => {
    const storeId = await seedStore('index-fail');
    indexStatusFails.on = true;
    try {
      const res = await get(storeId, '?days=7');
      expect(res.status).toBe(200);
      expect(res.body.data.totals).toMatchObject({ searches: 0 });
      expect(res.body.data.index).toBeUndefined();
    } finally {
      indexStatusFails.on = false;
    }
  });

  it('reports the smart-search index status of THIS store, and whether semantic search is on', async () => {
    const storeId = await seedStore('index');
    const other = await seedStore('index-other');
    const mk = async (store: string, name: string, data: Record<string, unknown> = {}) =>
      (
        await prisma.product.create({
          data: { storeId: store, slug: `p-${uid()}`, name, price: 100, status: 'active', ...data },
        })
      ).id;
    const ready = await mk(storeId, 'Ready');
    await mk(storeId, 'Waiting');
    const bad = await mk(storeId, 'Failing');
    await mk(storeId, 'Draft', { status: 'draft' }); // not searchable: not counted
    await mk(other, 'Elsewhere');
    const doc = (id: string) =>
      prisma.$queryRaw<Array<{ h: string }>>`
        SELECT md5(public.ebda_product_embed_doc(name, name_ar, description, description_ar)) AS h
          FROM products WHERE id = ${id}`.then(r => r[0].h);
    // The quarantine key is md5 of the doc + words SET (SEARCH-T13-7).
    const quarantineKey = (id: string) =>
      prisma.$queryRaw<Array<{ h: string }>>`
        SELECT md5(coalesce(public.ebda_product_embed_doc(name, name_ar, description, description_ar), '') || chr(31) || coalesce(nullif(regexp_replace(search_terms, '^\\s+|\\s+$', '', 'g'), ''), '')) AS h
          FROM products WHERE id = ${id}`.then(r => r[0].h);
    const vec = `[${new Array(1024).fill(0.01).join(',')}]`;
    await prisma.$executeRaw`
      INSERT INTO product_embeddings (product_id, store_id, model, content_hash, embedding)
      VALUES (${ready}, ${storeId}, '@cf/baai/bge-m3', ${await doc(ready)}, ${vec}::halfvec(1024))`;
    await prisma.$executeRaw`
      INSERT INTO product_embed_failures (product_id, store_id, content_hash, error_kind, model)
      VALUES (${bad}, ${storeId}, ${await quarantineKey(bad)}, 'input', '@cf/baai/bge-m3')`;
    const res = await get(storeId, '?days=7');
    expect(res.status).toBe(200);
    expect(res.body.data.index).toEqual({
      products: 3,
      indexed: 1,
      stale: 1,
      failed: 1,
      semanticEnabled: false,
    });
    const { setEmbeddingProviderForTests } =
      await import('../../apps/api/src/lib/search/embedding-provider');
    process.env.SEARCH_SEMANTIC_ENABLED = 'true';
    setEmbeddingProviderForTests({ model: 'm', embed: async () => [] });
    try {
      expect((await get(storeId, '?days=7')).body.data.index.semanticEnabled).toBe(true);
    } finally {
      setEmbeddingProviderForTests(undefined);
      delete process.env.SEARCH_SEMANTIC_ENABLED;
    }
    await prisma.product.deleteMany({ where: { storeId: { in: [storeId, other] } } });
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

  it.each([
    ['store_admin', 200],
    ['super_admin', 200],
    ['staff', 200], // staff hold analytics:read (Ruling SEARCH-T6-1)
    ['customer', 403], // no analytics:read
  ])('role %s gets %i', async (role, status) => {
    const storeId = await seedStore(`role-${role}`);
    const res = await request(app)
      .get(`/api/v1/stores/${storeId}/search-insights?days=7`)
      .set('x-test-role', role);
    expect(res.status).toBe(status);
  });

  it('runs authenticate → MFA → permission → requireStoreAccess, in that order', async () => {
    const storeId = await seedStore('chain');
    await get(storeId, '?days=7');
    expect(calls).toEqual(['authenticate', 'mfa', 'storeAccess']);
    calls.length = 0;
    // The permission check sits BEFORE store access: a refused role never reaches it.
    await request(app)
      .get(`/api/v1/stores/${storeId}/search-insights?days=7`)
      .set('x-test-role', 'customer');
    expect(calls).toEqual(['authenticate', 'mfa']);
  });
});
