/**
 * Search program Task 12: hybrid storefront search (keyword leg + vector leg, RRF) against a real
 * Postgres 17 + pgvector. A deterministic fake provider stands in for Workers AI; an alias map lets
 * a query with ZERO keyword matches embed to a product's vector (the semantic-only hit). Store
 * isolation of the vector leg is proven on the strict-RLS role `ebda_app` with the guard on, AND on
 * the owner client (RLS bypassed) so the explicit `store_id` filter is proven on its own.
 * With SEARCH_SEMANTIC_ENABLED=false the storefront list must be exactly today's (no provider call,
 * newest-first order, same meta keys).
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import crypto from 'node:crypto';
import {
  prisma,
  createPrismaClient,
  runWithRequestDb,
  runInStoreScope,
  runInTenantContext,
} from '@ebda/database';
import { hasDb } from '../helpers/bundle-fixtures';
import { fakeVector } from '../helpers/fake-embeddings';

vi.hoisted(() => {
  process.env.SEARCH_EMBED_THROTTLE_MS = '0';
});
vi.mock('../../apps/api/src/lib/inngest/client', () => ({
  inngest: { send: vi.fn(async () => ({ ids: [] })), createFunction: vi.fn(() => ({})) },
}));
vi.mock('../../apps/api/src/services/alerts.service', () => ({ sendAlert: vi.fn(async () => {}) }));

const { setEmbeddingProviderForTests, EMBED_MODEL } =
  await import('../../apps/api/src/lib/search/embedding-provider');
type EmbedOptions = import('../../apps/api/src/lib/search/embedding-provider').EmbedOptions;
const { indexStore } = await import('../../apps/api/src/services/product-index.service');
const {
  rankedSearch,
  semanticProductIds,
  clearQueryVectorCacheForTests,
  QUERY_EMBED_BUDGET_MS,
  PRODUCT_SEARCH_ID_CAP,
} = await import('../../apps/api/src/services/product-search.service');
const { ProductService } = await import('../../apps/api/src/services/product.service');

const OWNER_URL = process.env.DIRECT_URL || process.env.DATABASE_URL || '';
function appUrl(): string {
  const u = new URL(OWNER_URL);
  u.username = 'ebda_app';
  u.password = process.env.EBDA_APP_PASSWORD || 'ci-only-app-pw';
  return u.toString();
}
/** As production runs: the guarded client on the strict-RLS role `ebda_app`. */
const asApp = <T>(fn: () => Promise<T>) =>
  runWithRequestDb(() => createPrismaClient({ connectionString: appUrl(), max: 3 }), fn);

/** Fake bge-m3: same text → same vector; `alias` maps a query to the text whose vector it gets. */
function aliasProvider(alias: Record<string, string | number[]> = {}) {
  const calls: string[][] = [];
  const options: Array<EmbedOptions | undefined> = [];
  return {
    calls,
    options,
    provider: {
      model: EMBED_MODEL,
      async embed(texts: string[], opts?: EmbedOptions) {
        calls.push(texts);
        options.push(opts);
        return texts.map(t => {
          const a = alias[t];
          return Array.isArray(a) ? a : fakeVector(a ?? t);
        });
      },
    },
  };
}

const docOf = async (productId: string) =>
  (
    await prisma.$queryRaw<Array<{ doc: string }>>`
      SELECT public.ebda_product_embed_doc(name, name_ar, search_terms, description, description_ar) AS doc
        FROM products WHERE id = ${productId}`
  )[0].doc;

const ownerIds: string[] = [];
const storeIds: string[] = [];
async function mkStore(tag: string) {
  const owner = await prisma.user.create({
    data: {
      email: `hy-${tag}-${crypto.randomUUID().slice(0, 8)}@test.local`,
      passwordHash: 'x',
      firstName: 'H',
      lastName: 'Y',
      role: 'store_admin',
      emailVerified: true,
    },
  });
  ownerIds.push(owner.id);
  const s = await prisma.store.create({
    data: {
      name: `hy ${tag}`,
      slug: `hy-${tag}-${crypto.randomUUID().slice(0, 8)}`,
      ownerId: owner.id,
    },
  });
  storeIds.push(s.id);
  return s.id;
}
/** Names are FIXED text (no run tag) so the fake vectors, and so the distances, never vary per run. */
async function mkProduct(storeId: string, data: Record<string, unknown>) {
  return (
    await prisma.product.create({
      data: {
        storeId,
        slug: `p-${crypto.randomUUID().slice(0, 10)}`,
        price: 1000,
        status: 'active',
        ...data,
      } as never,
    })
  ).id;
}

const listPublic = (storeId: string, opts: Parameters<typeof ProductService.listPublic>[1]) =>
  runInTenantContext(storeId, () => ProductService.listPublic(storeId, opts));
const pageIds = (r: { products: Array<{ id: string }> }) => r.products.map(p => p.id);

describe.skipIf(!hasDb)('hybrid storefront search (Task 12)', () => {
  let S: string;
  let F: string;
  const p: Record<string, string> = {};
  let sneakerDoc: string;
  let foreignDoc: string;

  beforeAll(async () => {
    const { redis } = await import('../../apps/api/src/services/redis.service');
    await redis.connect();
    const { embedCallBudgetKey } = await import('../../apps/api/src/lib/search/embed-budget');
    await redis.getClient()?.del(embedCallBudgetKey(new Date()));

    S = await mkStore('main');
    F = await mkStore('foreign');
    // Keyword matches for "shoes" / "احذيه", created in a known order (newest-first = shoe2, shoe3, shoe1).
    p.shoe1 = await mkProduct(S, {
      name: 'Leather shoes',
      nameAr: 'احذية جلد',
      price: 3000,
      createdAt: new Date('2026-01-01T00:00:00Z'),
    });
    p.shoe2 = await mkProduct(S, {
      name: 'Canvas shoes',
      price: 2000,
      createdAt: new Date('2026-01-03T00:00:00Z'),
    });
    p.shoe3 = await mkProduct(S, {
      name: 'Kids shoes',
      price: 1500,
      createdAt: new Date('2026-01-02T00:00:00Z'),
    });
    // Semantic-only target: no keyword in common with "كوتشي".
    p.sneaker = await mkProduct(S, {
      name: 'Sport trainer',
      nameAr: 'حذاء رياضي',
      price: 5000,
      createdAt: new Date('2026-01-04T00:00:00Z'),
    });
    p.draft = await mkProduct(S, { name: 'Wool scarf', nameAr: 'كوفية صوف' });
    p.deleted = await mkProduct(S, { name: 'Silk tie', nameAr: 'كرافتة حرير' });
    p.foreign = await mkProduct(F, { name: 'Gold ring', nameAr: 'خاتم دهب' });

    const f = aliasProvider();
    setEmbeddingProviderForTests(f.provider);
    await runInStoreScope(S, () => indexStore(S));
    await runInStoreScope(F, () => indexStore(F));
    setEmbeddingProviderForTests(undefined);
    const embedded = await prisma.$queryRaw<Array<{ n: bigint }>>`
      SELECT count(*) AS n FROM product_embeddings WHERE store_id IN (${S}, ${F})`;
    expect(Number(embedded[0].n)).toBe(7);

    sneakerDoc = await docOf(p.sneaker);
    foreignDoc = await docOf(p.foreign);
    // Indexed while active; now leave the storefront without the indexer running again.
    await prisma.product.update({ where: { id: p.draft }, data: { status: 'draft' } });
    await prisma.product.update({ where: { id: p.deleted }, data: { deletedAt: new Date() } });
  });

  afterEach(() => {
    setEmbeddingProviderForTests(undefined);
    clearQueryVectorCacheForTests();
    delete process.env.SEARCH_SEMANTIC_ENABLED;
    delete process.env.SEARCH_VECTOR_MAX_DISTANCE;
  });

  afterAll(async () => {
    for (const id of storeIds) {
      await prisma.product.deleteMany({ where: { storeId: id } });
      await prisma.store.deleteMany({ where: { id } });
    }
    await prisma.user.deleteMany({ where: { id: { in: ownerIds } } });
  });

  // ---- vector leg -----------------------------------------------------------------------------

  it('zero keyword hits → the vector leg still returns the product', async () => {
    process.env.SEARCH_SEMANTIC_ENABLED = 'true';
    setEmbeddingProviderForTests(aliasProvider({ كوتشي: sneakerDoc }).provider);
    const ids = await runInTenantContext(S, () => rankedSearch(S, 'كوتشي'));
    expect(ids).toEqual([p.sneaker]);
  });

  it("never returns another store's product: ebda_app (RLS + guard)", async () => {
    process.env.SEARCH_SEMANTIC_ENABLED = 'true';
    setEmbeddingProviderForTests(aliasProvider({ ring: foreignDoc }).provider);
    const ids = await asApp(() => runInTenantContext(S, () => semanticProductIds(S, 'ring')));
    expect(ids).not.toContain(p.foreign);
    // Positive control: the same query in the foreign store finds it, so the vector did match.
    const own = await asApp(() => runInTenantContext(F, () => semanticProductIds(F, 'ring')));
    expect(own).toEqual([p.foreign]);
  });

  it("never returns another store's product: owner client (RLS bypassed, store_id filter alone)", async () => {
    process.env.SEARCH_SEMANTIC_ENABLED = 'true';
    setEmbeddingProviderForTests(aliasProvider({ ring: foreignDoc }).provider);
    const ids = await runInTenantContext(S, () => semanticProductIds(S, 'ring'));
    expect(ids).toEqual([]);
  });

  it('soft-deleted and draft products never come back from the vector leg', async () => {
    process.env.SEARCH_SEMANTIC_ENABLED = 'true';
    const draftDoc = await docOf(p.draft);
    const deletedDoc = await docOf(p.deleted);
    // The stale vectors are still in the table (the indexer has not pruned them yet).
    const rows = await prisma.$queryRaw<Array<{ n: bigint }>>`
      SELECT count(*) AS n FROM product_embeddings WHERE product_id IN (${p.draft}, ${p.deleted})`;
    expect(Number(rows[0].n)).toBe(2);
    const f = aliasProvider({ draftq: draftDoc, deletedq: deletedDoc });
    setEmbeddingProviderForTests(f.provider);
    expect(await runInTenantContext(S, () => semanticProductIds(S, 'draftq'))).toEqual([]);
    expect(await runInTenantContext(S, () => semanticProductIds(S, 'deletedq'))).toEqual([]);
    // Both queries were really embedded (not skipped as too short), so the SQL filter is what hid them.
    expect(f.calls).toHaveLength(2);
    // Positive control: republished, the same vector is found again.
    await prisma.product.update({ where: { id: p.draft }, data: { status: 'active' } });
    try {
      expect(await runInTenantContext(S, () => semanticProductIds(S, 'draftq'))).toEqual([p.draft]);
    } finally {
      await prisma.product.update({ where: { id: p.draft }, data: { status: 'draft' } });
    }
  });

  it('honours SEARCH_VECTOR_MAX_DISTANCE', async () => {
    process.env.SEARCH_SEMANTIC_ENABLED = 'true';
    // ~0.2 cosine distance from the sneaker's vector: 0.8·v + 0.6·(an unrelated vector).
    const v = fakeVector(sneakerDoc);
    const r = fakeVector('unrelated noise');
    const near = v.map((x, i) => 0.8 * x + 0.6 * r[i]);
    setEmbeddingProviderForTests(aliasProvider({ near }).provider);
    expect(await runInTenantContext(S, () => semanticProductIds(S, 'near'))).toEqual([p.sneaker]);
    clearQueryVectorCacheForTests();
    process.env.SEARCH_VECTOR_MAX_DISTANCE = '0.05';
    expect(await runInTenantContext(S, () => semanticProductIds(S, 'near'))).toEqual([]);
  });

  it('falls back to keyword results when the provider throws', async () => {
    process.env.SEARCH_SEMANTIC_ENABLED = 'true';
    setEmbeddingProviderForTests({
      model: EMBED_MODEL,
      embed: async () => {
        throw new Error('5xx');
      },
    });
    const ids = await runInTenantContext(S, () => rankedSearch(S, 'احذيه'));
    expect(ids).toEqual([p.shoe1]);
  });

  it(`a slow provider loses the ~${400} ms race: keyword results, and the call is aborted`, async () => {
    process.env.SEARCH_SEMANTIC_ENABLED = 'true';
    let signal: AbortSignal | undefined;
    setEmbeddingProviderForTests({
      model: EMBED_MODEL,
      // Never answers and ignores the signal: the race must still end on time.
      embed: (_t: string[], opts?: EmbedOptions) => {
        signal = opts?.signal;
        return new Promise<number[][]>(() => {});
      },
    });
    const t0 = Date.now();
    const ids = await runInTenantContext(S, () => rankedSearch(S, 'احذيه'));
    const took = Date.now() - t0;
    expect(ids).toEqual([p.shoe1]);
    expect(QUERY_EMBED_BUDGET_MS).toBeLessThanOrEqual(500);
    expect(took).toBeLessThan(QUERY_EMBED_BUDGET_MS + 1500);
    expect(signal?.aborted).toBe(true);
  });

  it('disabled flag → keyword only, provider never called', async () => {
    process.env.SEARCH_SEMANTIC_ENABLED = 'false';
    const f = aliasProvider({ كوتشي: sneakerDoc });
    setEmbeddingProviderForTests(f.provider);
    expect(await runInTenantContext(S, () => rankedSearch(S, 'احذيه'))).toEqual([p.shoe1]);
    expect(await runInTenantContext(S, () => rankedSearch(S, 'كوتشي'))).toEqual([]);
    expect(f.calls).toHaveLength(0);
  });

  it('no query embedding for very short, SKU-like or personal-data-shaped queries', async () => {
    process.env.SEARCH_SEMANTIC_ENABLED = 'true';
    const f = aliasProvider();
    setEmbeddingProviderForTests(f.provider);
    for (const q of ['ab', 'SKU-1234', 'ab12', '01012345678', '٠١٠١٢٣٤٥٦٧٨', 'me@x.com', '  '])
      await runInTenantContext(S, () => rankedSearch(S, q));
    expect(f.calls).toHaveLength(0);
    await runInTenantContext(S, () => rankedSearch(S, 'shoes'));
    expect(f.calls).toHaveLength(1);
  });

  it('caches the query vector per store and normalised query', async () => {
    process.env.SEARCH_SEMANTIC_ENABLED = 'true';
    const f = aliasProvider();
    setEmbeddingProviderForTests(f.provider);
    await runInTenantContext(S, () => semanticProductIds(S, 'احذية رياضية'));
    await runInTenantContext(S, () => semanticProductIds(S, 'احذيه رياضيه')); // same once folded
    expect(f.calls).toHaveLength(1);
    await runInTenantContext(F, () => semanticProductIds(F, 'احذية رياضية'));
    expect(f.calls).toHaveLength(2);
    // A failure is not cached: the next request tries again.
    clearQueryVectorCacheForTests();
    let n = 0;
    setEmbeddingProviderForTests({
      model: EMBED_MODEL,
      embed: async () => {
        n++;
        throw new Error('5xx');
      },
    });
    await runInTenantContext(S, () => semanticProductIds(S, 'shoes'));
    await runInTenantContext(S, () => semanticProductIds(S, 'shoes'));
    expect(n).toBe(2);
  });

  it('keyword leg keeps every match up to the 1000 cap (E10), not just the fused head of 50', async () => {
    expect(PRODUCT_SEARCH_ID_CAP).toBe(1000);
    const B = await mkStore('boots');
    await prisma.product.createMany({
      data: Array.from({ length: 60 }, (_, i) => ({
        storeId: B,
        slug: `boot-${i}-${crypto.randomUUID().slice(0, 8)}`,
        name: `Boot ${i}`,
        price: 1000,
        status: 'active' as const,
      })),
    });
    setEmbeddingProviderForTests(aliasProvider().provider);
    await runInStoreScope(B, () => indexStore(B));
    const target = (await prisma.product.findFirst({ where: { storeId: B, name: 'Boot 55' } }))!.id;
    process.env.SEARCH_SEMANTIC_ENABLED = 'true';
    setEmbeddingProviderForTests(aliasProvider({ boots: await docOf(target) }).provider);
    const ids = await runInTenantContext(B, () => rankedSearch(B, 'boot'));
    expect(ids).toHaveLength(60);
    expect(new Set(ids).size).toBe(60);
    clearQueryVectorCacheForTests();
    const ranked = await runInTenantContext(B, () => rankedSearch(B, 'boots'));
    // "boots" matches no "Boot N" by keyword: the vector leg alone answers (zero-result fallback).
    expect(ranked).toEqual([target]);
    setEmbeddingProviderForTests(aliasProvider({ boot: await docOf(target) }).provider);
    clearQueryVectorCacheForTests();
    const fused = await runInTenantContext(B, () => rankedSearch(B, 'boot'));
    expect(fused).toHaveLength(60);
    expect(new Set(fused).size).toBe(60);
    expect(fused.indexOf(target)).toBeLessThan(2); // pulled up from wherever the keyword leg had it
    const r = await listPublic(B, { search: 'boot', limit: 20, page: 3 });
    expect(r.meta).toMatchObject({ total: 60, totalPages: 3, ranked: true });
    expect(pageIds(r)).toEqual(fused.slice(40, 60));
  });

  // ---- storefront list (listPublic) -----------------------------------------------------------

  it('flag off: the storefront list is exactly today’s (newest first, no provider call)', async () => {
    process.env.SEARCH_SEMANTIC_ENABLED = 'false';
    const f = aliasProvider({ shoes: sneakerDoc });
    setEmbeddingProviderForTests(f.provider);
    const r = await listPublic(S, { search: 'shoes' });
    expect(pageIds(r)).toEqual([p.shoe2, p.shoe3, p.shoe1]);
    expect(r.meta).toEqual({
      page: 1,
      limit: 20,
      total: 3,
      totalPages: 1,
      nextCursor: undefined,
      skipCapped: undefined,
    });
    // sort=relevance is the same request as no sort while the flag is off.
    const rel = await listPublic(S, { search: 'shoes', sort: 'relevance' });
    expect(JSON.stringify(rel)).toBe(JSON.stringify(r));
    // Zero keyword hits stay zero.
    expect(pageIds(await listPublic(S, { search: 'كوتشي' }))).toEqual([]);
    expect(f.calls).toHaveLength(0);
  });

  it('flag on: a semantic-only hit is listed, ranked, with the meta + facets shape', async () => {
    process.env.SEARCH_SEMANTIC_ENABLED = 'true';
    setEmbeddingProviderForTests(aliasProvider({ كوتشي: sneakerDoc }).provider);
    const r = await listPublic(S, { search: 'كوتشي' });
    expect(pageIds(r)).toEqual([p.sneaker]);
    expect(r.meta).toMatchObject({ page: 1, limit: 20, total: 1, totalPages: 1, ranked: true });
    expect(Array.isArray(r.facets)).toBe(true);
    // The card row is the same storefront-safe listing shape as the other paths.
    expect(r.products[0]).toMatchObject({ id: p.sneaker, name: 'Sport trainer' });
    expect(r.products[0]).not.toHaveProperty('lowStockThreshold');
  });

  it('flag on: every other filter applies to the ranked set (price, ids)', async () => {
    process.env.SEARCH_SEMANTIC_ENABLED = 'true';
    setEmbeddingProviderForTests(aliasProvider({ shoes: sneakerDoc }).provider);
    const all = await listPublic(S, { search: 'shoes' });
    expect(new Set(pageIds(all))).toEqual(new Set([p.shoe1, p.shoe2, p.shoe3, p.sneaker]));
    const cheap = await listPublic(S, { search: 'shoes', maxPrice: 2500 });
    expect(new Set(pageIds(cheap))).toEqual(new Set([p.shoe2, p.shoe3]));
    expect(cheap.meta.total).toBe(2);
    const picked = await listPublic(S, { search: 'shoes', ids: [p.shoe1, p.sneaker] });
    expect(new Set(pageIds(picked))).toEqual(new Set([p.shoe1, p.sneaker]));
  });

  it('flag on: an explicit sort keeps the keyword path (no provider call)', async () => {
    process.env.SEARCH_SEMANTIC_ENABLED = 'true';
    const f = aliasProvider({ shoes: sneakerDoc });
    setEmbeddingProviderForTests(f.provider);
    const r = await listPublic(S, { search: 'shoes', sort: 'price_asc' });
    expect(pageIds(r)).toEqual([p.shoe3, p.shoe2, p.shoe1]);
    expect(f.calls).toHaveLength(0);
  });

  it('flag on: page and cursor paging walk the same deterministic order, no gaps or repeats', async () => {
    process.env.SEARCH_SEMANTIC_ENABLED = 'true';
    setEmbeddingProviderForTests(aliasProvider({ shoes: sneakerDoc }).provider);
    const full = pageIds(await listPublic(S, { search: 'shoes', limit: 10 }));
    expect(full).toHaveLength(4);
    // The fused head ranks the product both legs found first.
    expect(full[0]).toBe(p.sneaker);
    const byPage: string[] = [];
    for (let page = 1; page <= 4; page++) {
      const r = await listPublic(S, { search: 'shoes', limit: 1, page });
      expect(r.meta).toMatchObject({ total: 4, totalPages: 4 });
      byPage.push(...pageIds(r));
    }
    expect(byPage).toEqual(full);
    const byCursor = pageIds(await listPublic(S, { search: 'shoes', limit: 1 }));
    let cursor: string | undefined = byCursor[0];
    for (let i = 0; i < 10 && cursor; i++) {
      const r = await listPublic(S, { search: 'shoes', limit: 1, cursor });
      byCursor.push(...pageIds(r));
      cursor = r.meta.nextCursor;
    }
    expect(byCursor).toEqual(full);
  });

  it('flag on + provider down: the list still answers with the keyword matches', async () => {
    process.env.SEARCH_SEMANTIC_ENABLED = 'true';
    setEmbeddingProviderForTests({
      model: EMBED_MODEL,
      embed: async () => {
        throw new Error('5xx');
      },
    });
    const r = await listPublic(S, { search: 'shoes' });
    expect(new Set(pageIds(r))).toEqual(new Set([p.shoe1, p.shoe2, p.shoe3]));
    expect(r.meta.total).toBe(3);
  });
});
