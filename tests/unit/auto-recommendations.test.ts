/**
 * Automatic product recommendations: merchant picks first, then AI / bought-together, then similar items (Vectorize
 * neighbours), capped at 8, tenant-isolated, fail-soft, switchable by the merchant.
 *
 * The fake Vectorize holds vectors of TWO stores and answers a query only from the namespace it is asked for, like the real
 * index; the fake database holds both stores' products and honours `storeId` only when the code asks for it, so a dropped
 * `storeId` filter or `namespace` shows up as another store's product in the list.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const A = 'store-a';
const B = 'store-b';

type P = {
  id: string;
  storeId: string;
  inventory: number;
  status?: string;
  categoryIds?: string[];
};
const h = vi.hoisted(() => ({
  products: [] as any[],
  relations: [] as any[],
  ai: [] as any[],
  fbt: [] as any[],
  settings: {} as Record<string, unknown>,
  vectors: new Map<string, { ns: string; values: number[] }>(),
  vectorMode: { leak: false, fail: false, hang: false, absent: false },
  queries: [] as any[],
  cached: new Map<string, { v: unknown; ttl: number }>(),
}));

const baseProduct = (p: P) => ({
  id: p.id,
  storeId: p.storeId,
  name: p.id,
  nameAr: p.id,
  slug: p.id,
  price: 10,
  inventory: p.inventory,
  allowBackorder: false,
  lowStockThreshold: 0,
  trackInventory: true,
  status: p.status ?? 'active',
  deletedAt: null,
  audience: 'public',
  variants: [],
  images: [],
  categoryIds: p.categoryIds ?? [],
});

const matches = (row: any, where: any): boolean => {
  if (!where) return true;
  if (where.storeId !== undefined && row.storeId !== where.storeId) return false;
  if (where.id?.in && !where.id.in.includes(row.id)) return false;
  if (where.id?.notIn && where.id.notIn.includes(row.id)) return false;
  if (where.status !== undefined && row.status !== where.status) return false;
  if (where.categories?.some) {
    const want = where.categories.some.categoryId.in as string[];
    if (!row.categoryIds.some((c: string) => want.includes(c))) return false;
  }
  return true;
};
const productById = (id: string) => h.products.find(p => p.id === id);

const db = {
  product: {
    findMany: async ({ where, take }: any) =>
      h.products.filter(p => matches(p, where)).slice(0, take ?? 1000),
  },
  productCategory: {
    findMany: async ({ where }: any) =>
      (productById(where.productId)?.categoryIds ?? []).map((categoryId: string) => ({
        categoryId,
      })),
  },
  productRelation: {
    findMany: async ({ where, take }: any) =>
      h.relations
        .filter(
          r =>
            r.storeId === where.storeId &&
            (where.sourceProductId.in
              ? where.sourceProductId.in.includes(r.sourceProductId)
              : r.sourceProductId === where.sourceProductId) &&
            r.type === where.type
        )
        .sort((x, y) => x.position - y.position)
        .slice(0, take ?? 1000)
        .map(r => ({
          sourceProductId: r.sourceProductId,
          targetProductId: r.targetProductId,
          id: r.id,
          position: r.position,
          targetProduct: baseProduct(productById(r.targetProductId)),
        })),
  },
  aiRecommendation: {
    findMany: async ({ where, take }: any) =>
      h.ai
        .filter(r => r.storeId === where.storeId && r.sourceProductId === where.sourceProductId)
        .slice(0, take ?? 1000)
        .map(r => ({
          score: r.score,
          reason: null,
          targetProduct: baseProduct(productById(r.targetProductId)),
        })),
  },
  frequentlyBoughtTogether: {
    findMany: async ({ where, take }: any) =>
      h.fbt
        .filter(
          r =>
            r.storeId === where.storeId &&
            (where.OR[0].productId1.in
              ? where.OR[0].productId1.in.includes(r.productId1) ||
                where.OR[1].productId2.in.includes(r.productId2)
              : r.productId1 === where.OR[0].productId1 || r.productId2 === where.OR[1].productId2)
        )
        .sort((x, y) => y.coOccurrenceCount - x.coOccurrenceCount)
        .slice(0, take ?? 1000)
        .map(r => ({
          ...r,
          product1: baseProduct(productById(r.productId1)),
          product2: baseProduct(productById(r.productId2)),
        })),
  },
};

vi.mock('@ebda/database', () => ({ prisma: {} }));
vi.mock('../../apps/api/src/lib/repo-factory', () => ({
  storeDb: async () => db,
  storeWriter: async () => db,
}));
vi.mock('../../apps/api/src/lib/store-scoped-read', () => ({
  readInStoreContext: async (_id: string, fn: () => unknown) => fn(),
}));
vi.mock('../../apps/api/src/services/redis.service', () => ({
  redis: {
    get: async (k: string) => h.cached.get(k)?.v ?? null,
    set: async (k: string, v: unknown, ttl: number) => void h.cached.set(k, { v, ttl }),
    delete: async () => undefined,
    getClient: () => null,
    acquireLock: async () => true,
    releaseLock: async () => undefined,
  },
}));
vi.mock('../../apps/api/src/lib/leader-election', () => ({
  withLeaderLock: async () => undefined,
}));
vi.mock('../../apps/api/src/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../apps/api/src/services/store.service', () => ({
  StoreService: { getById: async () => ({ settings: h.settings }) },
}));
vi.mock('../../apps/api/src/cf/bindings', () => ({
  cfBindings: () =>
    h.vectorMode.absent
      ? {}
      : {
          PRODUCT_VECTORS: {
            getByIds: async (ids: string[]) => {
              if (h.vectorMode.hang) return new Promise(() => undefined);
              if (h.vectorMode.fail) throw new Error('vectorize down');
              return ids
                .filter(id => h.vectors.has(id))
                .map(id => ({
                  id,
                  values: h.vectors.get(id)!.values,
                  namespace: h.vectors.get(id)!.ns,
                }));
            },
            query: async (values: number[], opts: any) => {
              h.queries.push(opts);
              const dot = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i], 0);
              return {
                matches: [...h.vectors.entries()]
                  // the real index answers from the namespace it is given; `leak` simulates one that does not
                  .filter(([, v]) => h.vectorMode.leak || v.ns === opts.namespace)
                  .map(([id, v]) => ({ id, score: dot(values, v.values) })),
              };
            },
          },
        },
}));

import { recommendationService } from '../../apps/api/src/services/recommendation.service';
import { autoRecommendationsEnabled } from '../../apps/api/src/lib/recommendations/auto-setting';

const add = (id: string, storeId = A, inventory = 5, extra: Partial<P> = {}) =>
  h.products.push(baseProduct({ id, storeId, inventory, ...extra }));
/** A unit vector at `deg` degrees: the cosine score between two products is cos(difference). */
const vec = (id: string, deg: number, ns = A) => {
  const r = (deg * Math.PI) / 180;
  h.vectors.set(`${id}:d`, { ns, values: [Math.cos(r), Math.sin(r)] });
};
const ids = (xs: any[]) => xs.map(x => x.id);
const recs = (pid = 'p') => recommendationService.getProductRecommendations(A, pid);

beforeEach(() => {
  h.products.length = h.relations.length = h.ai.length = h.fbt.length = h.queries.length = 0;
  h.vectors.clear();
  h.cached.clear();
  h.settings = {};
  Object.assign(h.vectorMode, { leak: false, fail: false, hang: false, absent: false });
  add('p');
  vec('p', 0);
});

describe('similar items (Vectorize neighbours)', () => {
  it('lists the nearest products of THIS store, nearest first, never the product itself', async () => {
    add('s1');
    add('s2');
    vec('s1', 10);
    vec('s2', 20);
    const r = await recs();
    expect(ids(r.alsoLike as any[])).toEqual(['s1', 's2']);
    expect(h.queries.at(-1).namespace).toBe(A);
  });

  it("TENANT ISOLATION: another store's product never appears, even if the index answered across namespaces", async () => {
    add('own');
    vec('own', 15);
    add('foreign', B);
    vec('foreign', 1, B); // nearer than anything of store A
    expect(ids((await recs()).alsoLike as any[])).toEqual(['own']);

    h.cached.clear();
    h.vectorMode.leak = true; // a misbehaving index: the DB re-read (storeId) must still drop it
    expect(ids((await recs()).alsoLike as any[])).toEqual(['own']);
  });

  it('TENANT ISOLATION: a product id of another store gets no vector lookup answer', async () => {
    add('foreign', B);
    vec('foreign', 0, B);
    const r = await recommendationService.getProductRecommendations(A, 'foreign');
    expect(r.alsoLike).toEqual([]);
    expect(h.queries).toHaveLength(0);
  });

  it('skips sold-out and unpublished neighbours', async () => {
    add('out', A, 0);
    add('draft', A, 5, { status: 'draft' });
    add('ok');
    vec('out', 5);
    vec('draft', 6);
    vec('ok', 30);
    expect(ids((await recs()).alsoLike as any[])).toEqual(['ok']);
  });

  it('drops neighbours that are not similar at all (score floor)', async () => {
    add('far');
    vec('far', 80);
    expect((await recs()).alsoLike).toEqual([]);
  });

  it('fails soft: Vectorize error, hang or missing binding give no similar items and no throw', async () => {
    add('c1', A, 5, { categoryIds: ['x'] });
    h.products.find(p => p.id === 'p').categoryIds = ['x'];
    for (const mode of ['fail', 'absent'] as const) {
      h.cached.clear();
      h.vectorMode[mode] = true;
      const r = await recs();
      expect(ids(r.alsoLike as any[])).toEqual(['c1']); // the category fill still serves
      h.vectorMode[mode] = false;
    }
  });

  it('a hanging Vectorize is cut off by the tight timeout, and the degraded answer is cached only briefly', async () => {
    h.vectorMode.hang = true;
    const { similarProductIds } =
      await import('../../apps/api/src/lib/recommendations/similar-products');
    const t0 = Date.now();
    const out = await similarProductIds(A, 'p', 4, 50);
    expect(out).toEqual({ ids: [], degraded: true });
    expect(Date.now() - t0).toBeLessThan(1000);

    await recs(); // goes through the 600 ms race; use a fake timer free path: hang resolves by timeout
    const key = `recommendations:product:${A}:p`;
    expect(h.cached.get(key)!.ttl).toBe(30);
  });

  it('a healthy answer is cached for the full 5 minutes', async () => {
    add('s1');
    vec('s1', 10);
    await recs();
    expect(h.cached.get(`recommendations:product:${A}:p`)!.ttl).toBe(300);
  });
});

describe('order and cap', () => {
  it('merchant picks first, then bought-together, then similar, cap 8 in total', async () => {
    for (const id of ['m1', 'm2', 'f1', 'f2', 's1', 's2', 's3', 's4', 's5', 's6']) add(id);
    h.relations.push(
      {
        id: 'r1',
        storeId: A,
        sourceProductId: 'p',
        targetProductId: 'm1',
        type: 'cross_sell',
        position: 0,
      },
      {
        id: 'r2',
        storeId: A,
        sourceProductId: 'p',
        targetProductId: 'm2',
        type: 'cross_sell',
        position: 1,
      }
    );
    h.fbt.push(
      { storeId: A, productId1: 'p', productId2: 'f1', coOccurrenceCount: 9 },
      { storeId: A, productId1: 'f2', productId2: 'p', coOccurrenceCount: 4 }
    );
    ['s1', 's2', 's3', 's4', 's5', 's6'].forEach((s, i) => vec(s, 5 + i * 3));
    const r = await recs();
    expect(ids(r.crossSell as any[])).toEqual(['m1', 'm2', 'f1', 'f2']); // curated pick no longer hides the automatic ones
    expect(ids(r.alsoLike as any[])).toEqual(['s1', 's2', 's3', 's4']);
    expect(r.crossSell.length + r.upsell.length + r.alsoLike.length).toBe(8);
  });

  it('a product that is curated is not repeated as bought-together or similar', async () => {
    add('m1');
    h.relations.push({
      id: 'r1',
      storeId: A,
      sourceProductId: 'p',
      targetProductId: 'm1',
      type: 'cross_sell',
      position: 0,
    });
    h.fbt.push({ storeId: A, productId1: 'p', productId2: 'm1', coOccurrenceCount: 9 });
    vec('m1', 2);
    const r = await recs();
    expect(ids(r.crossSell as any[])).toEqual(['m1']);
    expect(r.alsoLike).toEqual([]);
  });
});

describe('merchant switch', () => {
  it('defaults to ON, reads only an explicit false as off', () => {
    expect(autoRecommendationsEnabled(undefined)).toBe(true);
    expect(autoRecommendationsEnabled({})).toBe(true);
    expect(autoRecommendationsEnabled({ autoRecommendationsEnabled: true })).toBe(true);
    expect(autoRecommendationsEnabled({ autoRecommendationsEnabled: false })).toBe(false);
  });

  it('OFF: curated picks only, no bought-together, no similar, no Vectorize call', async () => {
    h.settings = { autoRecommendationsEnabled: false };
    for (const id of ['m1', 'f1', 's1']) add(id);
    h.relations.push({
      id: 'r1',
      storeId: A,
      sourceProductId: 'p',
      targetProductId: 'm1',
      type: 'cross_sell',
      position: 0,
    });
    h.fbt.push({ storeId: A, productId1: 'p', productId2: 'f1', coOccurrenceCount: 9 });
    vec('s1', 5);
    const r = await recs();
    expect(ids(r.crossSell as any[])).toEqual(['m1']);
    expect(r.alsoLike).toEqual([]);
    expect(h.queries).toHaveLength(0);
  });

  it('OFF with no curated pick: nothing automatic fills the gap (bought-together and AI picks included)', async () => {
    h.settings = { autoRecommendationsEnabled: false };
    add('f1');
    add('a1');
    h.fbt.push({ storeId: A, productId1: 'p', productId2: 'f1', coOccurrenceCount: 9 });
    h.ai.push({ storeId: A, sourceProductId: 'p', targetProductId: 'a1', score: 0.9 });
    const r = await recs();
    expect(r.crossSell).toEqual([]);
  });

  it('the key is server-owned: a stale whole-settings PUT cannot flip it', async () => {
    const { mergeClientSettings } = await import('@ebda/shared');
    expect(
      mergeClientSettings(
        { autoRecommendationsEnabled: false },
        { autoRecommendationsEnabled: true }
      )
    ).toEqual({ autoRecommendationsEnabled: false });
  });
});

describe('cart', () => {
  const cart = (on = true) => {
    h.settings = on ? {} : { autoRecommendationsEnabled: false };
    return recommendationService.getCartRecommendations(A, ['p']);
  };
  it('a merchant pick sorts first and bought-together tops it up', async () => {
    for (const id of ['m1', 'f1', 'f2']) add(id);
    h.relations.push({
      id: 'r1',
      storeId: A,
      sourceProductId: 'p',
      targetProductId: 'm1',
      type: 'cross_sell',
      position: 0,
    });
    h.fbt.push(
      { storeId: A, productId1: 'p', productId2: 'f1', coOccurrenceCount: 9 },
      { storeId: A, productId1: 'p', productId2: 'f2', coOccurrenceCount: 3 }
    );
    expect(ids(await cart())).toEqual(['m1', 'f1', 'f2']);
  });
  it('OFF: curated only', async () => {
    for (const id of ['m1', 'f1']) add(id);
    h.relations.push({
      id: 'r1',
      storeId: A,
      sourceProductId: 'p',
      targetProductId: 'm1',
      type: 'cross_sell',
      position: 0,
    });
    h.fbt.push({ storeId: A, productId1: 'p', productId2: 'f1', coOccurrenceCount: 9 });
    expect(ids(await cart(false))).toEqual(['m1']);
  });
});
