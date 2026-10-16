/**
 * Search program Task 12, Ruling SEARCH-T12-7: no `/public/products` response can be served for a
 * request it was not computed for. Real Redis (the 120 s list cache), the real public router behind
 * `publicStoreContext`, the guarded `ebda_app` client. Every fixture is per CALL (fresh stores), so a
 * retry never meets an earlier attempt's cache entries.
 */
import crypto from 'crypto';
import { describe, it, expect, afterAll, beforeAll, afterEach, vi } from 'vitest';
import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';
import { prisma, createPrismaClient, runWithRequestDb, runInStoreScope } from '@ebda/database';
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
const { setEmbeddingProviderForTests, EMBED_MODEL } =
  await import('../../apps/api/src/lib/search/embedding-provider');
const { indexStore } = await import('../../apps/api/src/services/product-index.service');
const { clearQueryVectorCacheForTests } =
  await import('../../apps/api/src/services/product-search.service');
const { clearQueryBudgetSpentForTests } =
  await import('../../apps/api/src/lib/search/embed-budget');
const { ProductService } = await import('../../apps/api/src/services/product.service');

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
const app = buildApp();
const created = { storeIds: [] as string[], userIds: [] as string[] };
const uid = () => crypto.randomUUID().slice(0, 10);
const ip = () =>
  `10.${crypto.randomInt(1, 250)}.${crypto.randomInt(1, 250)}.${crypto.randomInt(1, 250)}`;
const word = () =>
  Array.from(crypto.randomBytes(8), b => String.fromCharCode(97 + (b % 26))).join('');

async function seedStore(tag: string, products: Array<Record<string, unknown>>) {
  const id = uid();
  const owner = await prisma.user.create({
    data: {
      email: `hsc-${tag}-${id}@test.local`,
      passwordHash: 'x',
      firstName: 'H',
      lastName: 'C',
      role: 'store_admin',
      status: 'active',
      emailVerified: true,
    },
  });
  created.userIds.push(owner.id);
  const store = await prisma.store.create({
    data: {
      name: `hsc ${tag} ${id}`,
      slug: `hsc-${tag}-${id}`,
      ownerId: owner.id,
      status: 'active',
    },
  });
  created.storeIds.push(store.id);
  const ids: string[] = [];
  for (const p of products)
    ids.push(
      (
        await prisma.product.create({
          data: {
            storeId: store.id,
            slug: `p-${uid()}`,
            price: 1000,
            status: 'active',
            ...p,
          } as never,
        })
      ).id
    );
  return { storeId: store.id, ids };
}
const get = (storeId: string, qs: string, headers: Record<string, string> = {}) => {
  let r = request(app)
    .get(`/api/v1/public/products?${qs}`)
    .set('x-store-id', storeId)
    .set('x-forwarded-for', ip());
  for (const [k, v] of Object.entries(headers)) r = r.set(k, v);
  return r;
};
const idsOf = (res: { body: { data: { products: Array<{ id: string }> } } }) =>
  res.body.data.products.map(p => p.id);

beforeAll(async () => {
  if (!hasDb) return;
  await redis.connect();
  expect(redis.isAvailable()).toBe(true);
});
afterEach(() => {
  vi.restoreAllMocks();
  setEmbeddingProviderForTests(undefined);
  clearQueryVectorCacheForTests();
  clearQueryBudgetSpentForTests();
  delete process.env.SEARCH_SEMANTIC_ENABLED;
  delete process.env.SEARCH_QUERY_EMBED_STORE_DAILY_CAP;
});
afterAll(async () => {
  if (!hasDb) return;
  await prisma.searchQueryDaily.deleteMany({ where: { storeId: { in: created.storeIds } } });
  await prisma.product.deleteMany({ where: { storeId: { in: created.storeIds } } });
  await prisma.category.deleteMany({ where: { storeId: { in: created.storeIds } } });
  await prisma.store.deleteMany({ where: { id: { in: created.storeIds } } });
  await prisma.user.deleteMany({ where: { id: { in: created.userIds } } });
  await redis.disconnect();
});

describe.skipIf(!hasDb)('/public/products cache keys and caching (Ruling SEARCH-T12-7)', () => {
  for (const flag of ['false', 'true'] as const) {
    it(`same query on two stores never shares an entry (semantic ${flag})`, async () => {
      process.env.SEARCH_SEMANTIC_ENABLED = flag;
      if (flag === 'true')
        setEmbeddingProviderForTests({
          model: EMBED_MODEL,
          embed: async t => t.map(x => fakeVector(x)),
        });
      const a = await seedStore('a', [{ name: 'Canvas shoes' }]);
      const b = await seedStore('b', [{ name: 'Leather shoes' }]);
      expect(idsOf(await get(a.storeId, 'search=shoes'))).toEqual(a.ids);
      expect(idsOf(await get(b.storeId, 'search=shoes'))).toEqual(b.ids);
      expect(idsOf(await get(a.storeId, 'search=shoes'))).toEqual(a.ids);
    });
  }

  it('Arabic and English requests get the same payload: it carries both languages', async () => {
    const s = await seedStore('lang', [{ name: 'Canvas shoes', nameAr: 'حذاء قماش' }]);
    const ar = await get(s.storeId, 'search=shoes', { 'accept-language': 'ar' });
    const en = await get(s.storeId, 'search=shoes', { 'accept-language': 'en' });
    expect(ar.body.data).toEqual(en.body.data);
    expect(ar.body.data.products[0]).toMatchObject({ name: 'Canvas shoes', nameAr: 'حذاء قماش' });
  });

  it('budget spent (cap 0): the keyword-only list IS cached under its own mode key', async () => {
    const s = await seedStore('spent0', [{ name: 'Canvas shoes' }]);
    setEmbeddingProviderForTests({
      model: EMBED_MODEL,
      embed: async t => t.map(x => fakeVector(x)),
    });
    process.env.SEARCH_SEMANTIC_ENABLED = 'true';
    process.env.SEARCH_QUERY_EMBED_STORE_DAILY_CAP = '0';
    const spy = vi.spyOn(ProductService, 'listPublic');
    const qs = `search=${encodeURIComponent(`shoes ${word()}`)}`;
    const first = await get(s.storeId, qs);
    expect(first.status).toBe(200);
    expect(spy).toHaveBeenCalledTimes(1);
    const second = await get(s.storeId, qs);
    expect(second.body.data).toEqual(first.body.data);
    expect(spy).toHaveBeenCalledTimes(1); // a cache hit: no service call
  });

  it('budget spent by use: discovered once (uncached), then cached under the spent mode', async () => {
    const s = await seedStore('spentuse', [{ name: 'Sport trainer' }]);
    setEmbeddingProviderForTests({
      model: EMBED_MODEL,
      embed: async t => t.map(x => fakeVector(x)),
    });
    process.env.SEARCH_SEMANTIC_ENABLED = 'true';
    process.env.SEARCH_QUERY_EMBED_STORE_DAILY_CAP = '1';
    await get(s.storeId, `search=${encodeURIComponent(`kotshy ${word()}`)}`); // spends the 1 call
    const spy = vi.spyOn(ProductService, 'listPublic');
    const qs = `search=${encodeURIComponent(`kotshy ${word()}`)}`;
    const discovered = await get(s.storeId, qs); // refused: this request learns the budget is spent
    expect(discovered.body.data.meta.degraded).toBe(true);
    await get(s.storeId, qs); // spent mode now known: computed and cached
    await get(s.storeId, qs); // hit
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('a transient failure (provider error) is never cached', async () => {
    const s = await seedStore('transient', [{ name: 'Sport trainer' }]);
    process.env.SEARCH_SEMANTIC_ENABLED = 'true';
    setEmbeddingProviderForTests({
      model: EMBED_MODEL,
      embed: async () => {
        throw new Error('5xx');
      },
    });
    const spy = vi.spyOn(ProductService, 'listPublic');
    const qs = `search=${encodeURIComponent(`kotshy ${word()}`)}`;
    expect((await get(s.storeId, qs)).body.data.meta.degraded).toBe(true);
    await get(s.storeId, qs);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('a keyword-only fallback is never cached: the same URL recovers when the budget does', async () => {
    const s = await seedStore('recover', [{ name: 'Sport trainer', nameAr: 'حذاء رياضي' }]);
    setEmbeddingProviderForTests({
      model: EMBED_MODEL,
      embed: async t => t.map(x => fakeVector(x)),
    });
    await runInStoreScope(s.storeId, () => indexStore(s.storeId));
    const doc = (
      await prisma.$queryRaw<Array<{ doc: string }>>`
        SELECT public.ebda_product_embed_doc(name, name_ar, search_terms, description, description_ar) AS doc
          FROM products WHERE id = ${s.ids[0]}`
    )[0].doc;
    setEmbeddingProviderForTests({
      model: EMBED_MODEL,
      embed: async t => t.map(x => fakeVector(x.startsWith('كوتشي') ? doc : x)),
    });
    process.env.SEARCH_SEMANTIC_ENABLED = 'true';
    const qs = `search=${encodeURIComponent(`كوتشي ${word()}`)}`;
    process.env.SEARCH_QUERY_EMBED_STORE_DAILY_CAP = '0'; // budget exhausted
    const degraded = await get(s.storeId, qs);
    expect(degraded.status).toBe(200);
    expect(idsOf(degraded)).toEqual([]);
    // A spent budget is a stable keyword-only MODE (review I1), not a transient failure.
    expect(degraded.body.data.meta).toMatchObject({ ranked: true });
    expect(degraded.body.data.meta.degraded).toBeUndefined();
    expect(degraded.headers['cache-control']).toBe('private, no-store');
    delete process.env.SEARCH_QUERY_EMBED_STORE_DAILY_CAP; // budget back
    const healthy = await get(s.storeId, qs);
    expect(idsOf(healthy)).toEqual(s.ids);
    expect(healthy.body.data.meta.degraded).toBeUndefined();
    expect(healthy.headers['cache-control']).toBe('private, no-store'); // ranked: never shared
  });

  it('values cannot borrow a delimiter: ?category=X:shoes&search=hat vs ?category=X&search=shoes:hat', async () => {
    const s = await seedStore('delim', [
      { name: 'Canvas shoes:hat edition' },
      { name: 'Wool hat' },
    ]);
    const slug = `cat${uid()}`;
    const cat = await prisma.category.create({ data: { storeId: s.storeId, name: 'Cat', slug } });
    await prisma.productCategory.createMany({
      data: s.ids.map((productId, position) => ({ productId, categoryId: cat.id, position })),
    });
    // Under the old `…:${category}:${search}:…` key both requests below built the SAME string
    // (`…:X:shoes:hat:…`): the first one filled the second one's entry.
    const poison = await get(
      s.storeId,
      `category=${encodeURIComponent(`${slug}:shoes`)}&search=hat`
    );
    expect(idsOf(poison)).toEqual([]); // no such category
    const real = await get(s.storeId, `category=${slug}&search=${encodeURIComponent('shoes:hat')}`);
    expect(idsOf(real)).toEqual([s.ids[0]]);
  });

  it('option-filter values cannot borrow a delimiter either (opt_A=1;B=2 vs opt_A=1&opt_B=2)', async () => {
    const s = await seedStore('optdelim', [{ name: 'Canvas shoes' }]);
    const opt = await prisma.productOption.create({
      data: {
        productId: s.ids[0],
        name: 'Size',
        values: { create: [{ value: 'S' }] },
      },
      include: { values: true },
    });
    const colour = await prisma.productOption.create({
      data: { productId: s.ids[0], name: 'Color', values: { create: [{ value: 'Red' }] } },
      include: { values: true },
    });
    await prisma.productVariant.create({
      data: {
        productId: s.ids[0],
        title: 'S / Red',
        inventory: 3,
        options: {
          create: [{ valueId: opt.values[0].id }, { valueId: colour.values[0].id }],
        },
      } as never,
    });
    const poison = await get(s.storeId, `opt_Size=${encodeURIComponent('S;Color=Red')}`);
    expect(idsOf(poison)).toEqual([]); // there is no size called "S;Color=Red"
    const real = await get(s.storeId, 'opt_Size=S&opt_Color=Red');
    expect(idsOf(real)).toEqual(s.ids);
  });

  it('listing params are scalars: arrays and objects are a 400, never a Prisma operator or a 500', async () => {
    const s = await seedStore('arr', [{ name: 'Canvas shoes' }, { name: 'Wool hat' }]);
    // An INACTIVE category: `category[startsWith]=…` used to reach Prisma as `slug: { startsWith }`
    // and list its products (a slug oracle); `category=a&category=b` used to 500.
    const hidden = await prisma.category.create({
      data: {
        storeId: s.storeId,
        name: 'Hidden',
        slug: `secret-${uid()}`,
        isActive: false,
      } as never,
    });
    await prisma.productCategory.create({ data: { productId: s.ids[0], categoryId: hidden.id } });
    for (const qs of [
      'category[startsWith]=secret',
      'category=a&category=b',
      'search=shoes&search=shoes',
      'search[]=shoes',
      'search[contains]=shoes',
      'sort[]=price_asc',
      'page[]=2',
      'ids[]=x',
      'cursor[gt]=a',
      'minPrice[]=1',
      'opt_Size[]=S',
      'opt_Size[equals]=S',
    ]) {
      const res = await get(s.storeId, qs);
      expect(res.status, qs).toBe(400);
      expect(res.body.error.code, qs).toBe('VALIDATION_ERROR');
    }
    const plain = await get(s.storeId, 'search=shoes');
    expect(idsOf(plain)).toEqual([s.ids[0]]);
  });

  it('typeahead: an array or object q is a 400 too', async () => {
    const s = await seedStore('sugarr', [{ name: 'Canvas shoes' }]);
    for (const qs of ['q=shoes&q=shoes', 'q[]=shoes', 'q[contains]=sh']) {
      const res = await request(app)
        .get(`/api/v1/public/${s.storeId}/search/suggest?${qs}`)
        .set('x-store-id', s.storeId);
      expect(res.status, qs).toBe(400);
    }
  });

  it('flipping semantic search on never serves the list cached while it was off', async () => {
    const s = await seedStore('flip', [{ name: 'Canvas shoes' }]);
    process.env.SEARCH_SEMANTIC_ENABLED = 'false';
    const off = await get(s.storeId, 'search=shoes');
    expect(off.body.data.meta.ranked).toBeUndefined();
    process.env.SEARCH_SEMANTIC_ENABLED = 'true';
    setEmbeddingProviderForTests({
      model: EMBED_MODEL,
      embed: async t => t.map(x => fakeVector(x)),
    });
    const on = await get(s.storeId, 'search=shoes');
    expect(on.body.data.meta.ranked).toBe(true);
    process.env.SEARCH_SEMANTIC_ENABLED = 'false';
    expect((await get(s.storeId, 'search=shoes')).body.data.meta.ranked).toBeUndefined();
  });

  it('typeahead: two terms that differ after folding never share an entry (É is not é)', async () => {
    const s = await seedStore('suggest', [{ name: 'écharpe en laine' }]);
    const suggest = (q: string) =>
      request(app)
        .get(`/api/v1/public/${s.storeId}/search/suggest?q=${encodeURIComponent(q)}`)
        .set('x-store-id', s.storeId);
    // The normaliser folds ASCII A-Z only (Ruling SEARCH-2), so "Écharpe" does not match "écharpe".
    // The old key lower-cased the raw term (`toLowerCase` folds É too), so both shared one entry.
    const upper = await suggest('Écharpe');
    expect(upper.body.data.suggestions).toEqual([]);
    const lower = await suggest('écharpe');
    expect(lower.body.data.suggestions.map((x: { id: string }) => x.id)).toEqual(s.ids);
  });

  it('a long request still caches: the key is hashed under the invalidation prefix (KV 512 B)', async () => {
    const s = await seedStore('longkey', [{ name: 'Canvas shoes' }]);
    const sets: string[] = [];
    const realSet = redis.set.bind(redis);
    vi.spyOn(redis, 'set').mockImplementation(async (k: string, v: unknown, ttl?: number) => {
      sets.push(k);
      return realSet(k, v as string, ttl);
    });
    const spy = vi.spyOn(ProductService, 'listPublic');
    const search = encodeURIComponent('حذاء '.repeat(20)); // 100 Arabic chars = 200 bytes
    const opts = Array.from({ length: 10 }, (_, i) => `opt_Option${i}=${'x'.repeat(30)}`).join('&');
    const qs = `search=${search}&category=${'c'.repeat(60)}&${opts}`;
    await get(s.storeId, qs);
    await get(s.storeId, qs);
    expect(spy).toHaveBeenCalledTimes(1); // the second request was a cache hit
    const listKey = sets.find(k => k.startsWith(`public:products:${s.storeId}:`))!;
    expect(new TextEncoder().encode(`cache:${listKey}`).length).toBeLessThanOrEqual(512);
    expect(listKey).toMatch(new RegExp(`^public:products:${s.storeId}:sha256:[0-9a-f]{64}$`));
    // A product write still busts the hashed entry (same prefix).
    const { invalidateStoreProductCaches } = await import('../../apps/api/src/lib/public-cache');
    await invalidateStoreProductCaches(s.storeId);
    await get(s.storeId, qs);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('semantic off: the edge policy of the list is unchanged (public, s-maxage)', async () => {
    process.env.SEARCH_SEMANTIC_ENABLED = 'false';
    const s = await seedStore('edge', [{ name: 'Canvas shoes' }]);
    const res = await get(s.storeId, 'search=shoes');
    expect(res.headers['cache-control']).toBe('public, s-maxage=60, stale-while-revalidate=300');
    expect(res.body.data.meta.ranked).toBeUndefined();
  });
});
