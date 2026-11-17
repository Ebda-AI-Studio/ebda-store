/**
 * STORE-EDGE-4 (quiet-hours perf): the storefront HTML edge copy may be served stale for up to STORE_EDGE_STALE_S (6 h),
 * so EVERY write that changes what a page renders must purge its store. The invalidation map (write path -> purge):
 *
 *   product / variant / price / sale / stock / status    ProductService, VariantService, InventoryService, bulk import,
 *                                                         catalog import, bulk-AI jobs, gold rate, orders (coalesced 10 s)
 *                                                         -> invalidateStoreProductCaches[AfterOrder] -> products|categories|bundles:<id>
 *   carousel order (new arrivals / best sellers)         product.routes reorder   -> invalidateStoreProductCaches   (was Redis-only)
 *   product FAQ create / update / delete                 product.routes           -> invalidateStoreProductCaches   (was none)
 *   AI autofill / balance / revert, name repair          writeAiFieldsGuarded, revertProductBalance, admin repair
 *                                                         -> invalidateStoreProductCaches                           (was none)
 *   blog post create / update / delete                   blog.routes              -> purgeStorefrontBlog -> blog:<id> (was none)
 *   categories, bundles                                  invalidateStoreCategoriesCaches / invalidateStoreProductCaches
 *   store settings / status / theme / layout / domain    bustStoreCaches (store.service), page-builder publish -> layout|store-*:<id>
 * Every purge lands in bumpEpochs (R2 epoch, global) which the edge copy checks on the fresh AND the stale copy.
 * Not edge-relevant (never rendered into a cached anonymous page): coupons/promotions (cart + checkout dry-run only),
 * price tiers + customer groups (signed-in buyers carry a cookie -> bypass), cart, shipping carrier config, barcodes.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

vi.mock('../../apps/api/src/services/redis.service', () => ({
  redis: {
    isAvailable: () => true,
    get: async () => null,
    set: async () => undefined,
    delete: async () => undefined,
    deleteByPattern: async () => 0,
    getCacheGenerations: async (names: string[]) => names.map(() => '0'),
    bumpCacheGeneration: async () => undefined,
  },
}));

const { invalidateStoreProductCaches, purgeStorefrontBlog } =
  await import('../../apps/api/src/lib/public-cache');
const {
  bumpEpochs,
  epochKeysForTag,
  serveStoreEdge,
  resetEpochMemo,
  resetStoreVerdicts,
  parseAllowlist,
  STORE_EDGE_FRESH_S,
  STORE_EDGE_STALE_S,
} = await import('../../apps/web/store-edge-cache');

const HOST = 'shop-a.ebda.app';
const ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BUILD = 'aaaaaaaa-1111-4111-8111-111111111111';

class MapCache {
  readonly m = new Map<string, Response>();
  async match(k: string) {
    return this.m.get(k)?.clone();
  }
  async put(k: string, r: Response) {
    this.m.set(k, r);
  }
}
class MapR2 {
  readonly m = new Map<string, string>();
  async get(k: string) {
    const v = this.m.get(k);
    return v === undefined ? null : { text: async () => v };
  }
  async put(k: string, v: string) {
    this.m.set(k, v);
  }
}

let clock: number;
let cache: MapCache;
let r2: MapR2;
let renders: number;
let price: string;
let posts: string[][];
const waits: Promise<unknown>[] = [];
const ctx = { waitUntil: (p: Promise<unknown>) => void waits.push(p) };
const deps = () => ({
  allow: parseAllowlist(HOST),
  r2,
  cache,
  build: BUILD,
  verdict: async () => ({ ok: true, id: ID }),
  now: () => clock,
});
const origin = async () => {
  renders++;
  return new Response(`<html>price ${price}</html>`, {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
};
async function get(url = `https://${HOST}/products/abaya`) {
  const res = await serveStoreEdge(
    new Request(url, { headers: { accept: 'text/html' } }),
    ctx,
    origin,
    deps()
  );
  await Promise.all(waits.splice(0));
  return { state: res.headers.get('x-store-edge'), body: await res.text() };
}
/** What the storefront Worker does with each purge POST the API sends: write the epochs. */
async function deliverPurges() {
  await new Promise(r => setTimeout(r, 0));
  expect(posts.length, 'the write path sent no storefront purge').toBeGreaterThan(0);
  for (const tags of posts.splice(0)) await bumpEpochs(r2, tags, clock);
}

beforeEach(() => {
  clock = 10_000_000;
  cache = new MapCache();
  r2 = new MapR2();
  renders = 0;
  price = '100 EGP';
  posts = [];
  waits.length = 0;
  resetEpochMemo();
  resetStoreVerdicts();
  process.env.STOREFRONT_REVALIDATE_URL = 'https://storefront.test';
  process.env.REVALIDATE_SECRET = 'test-secret';
  vi.stubGlobal('fetch', async (_u: string, init: { body: string }) => {
    posts.push((JSON.parse(init.body) as { tags: string[] }).tags);
    return new Response('{}', { status: 200 });
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('quiet hours: stale-while-revalidate serves the copy at once', () => {
  it('a visitor 2 h after the last one gets the cached page immediately (STALE), the refresh runs in the background', async () => {
    expect((await get()).state).toBe('MISS');
    clock += 2 * 3600 * 1000; // quiet hours: nobody asked for 2 h (the old 600 s window made this a cold render)
    price = '100 EGP';
    const r = await get();
    expect(r.state).toBe('STALE');
    expect(r.body).toContain('100 EGP');
    expect(renders).toBe(2); // 1 first render + 1 background refresh
    clock += 1_000;
    expect((await get()).state).toBe('HIT'); // the refresh re-stamped the copy
  });

  it('the windows are fresh 60 s, stale 6 h', () => {
    expect(STORE_EDGE_FRESH_S).toBe(60);
    expect(STORE_EDGE_STALE_S).toBe(21_600);
  });

  it('past 6 h it is a MISS again (outer bound)', async () => {
    await get();
    clock += (STORE_EDGE_STALE_S + 60) * 1000;
    expect((await get()).state).toBe('MISS');
  });
});

describe('price change: the next request shows the new price, even inside the stale window', () => {
  for (const [label, ageS] of [
    ['fresh copy (30 s old)', 30],
    ['stale copy (2 h old)', 2 * 3600],
    ['stale copy (5 h 59 m old)', 5 * 3600 + 59 * 60],
  ] as const) {
    it(`${label}: real invalidateStoreProductCaches -> purge POST -> epoch -> MISS with the new price`, async () => {
      await get();
      clock += ageS * 1000;
      price = '120 EGP'; // the merchant edits the price...
      await invalidateStoreProductCaches(ID); // ...ProductService / VariantService / bulk import all end here
      await deliverPurges();
      clock += 5_000;
      const r = await get();
      expect(r.state).toBe('MISS');
      expect(r.body).toContain('120 EGP');
    });
  }

  it('a blog write purges blog:<id>, which maps to the store epoch', async () => {
    await get(`https://${HOST}/blog`);
    clock += 3600 * 1000;
    purgeStorefrontBlog(ID);
    await deliverPurges();
    clock += 5_000;
    expect((await get(`https://${HOST}/blog`)).state).toBe('MISS');
    expect(epochKeysForTag(`blog:${ID}`)).toEqual([`id/${ID}`]);
  });
});

describe('write-path guard: every storefront-visible writer purges the edge (source)', () => {
  const read = (rel: string) => readFileSync(path.resolve(__dirname, '../..', rel), 'utf8');

  it('product.routes: carousel reorders and FAQ writes purge the storefront, never Redis only', () => {
    const src = read('apps/api/src/routes/product.routes.ts');
    expect(src).not.toMatch(/invalidateCachedPrefix\(/);
    for (const fn of ['createProductFaq(', 'deleteProductFaq(', 'productFaq.updateMany(']) {
      const at = src.indexOf(fn, src.indexOf('router.'));
      expect(at, fn).toBeGreaterThan(-1);
      expect(src.slice(at, at + 900), fn).toContain('invalidateStoreProductCaches(');
    }
    const reorders = src.match(/(newArrivalPosition|bestSellerPosition): index/g) ?? [];
    expect(reorders).toHaveLength(2);
    expect(
      src.match(/await invalidateStoreProductCaches\(storeId\)/g)?.length
    ).toBeGreaterThanOrEqual(2);
  });

  it('blog.routes: create, update and delete each purge blog:<storeId>', () => {
    const src = read('apps/api/src/routes/blog.routes.ts');
    for (const call of ['BlogService.create(', 'BlogService.update(', 'BlogService.remove(']) {
      const at = src.indexOf(call);
      expect(at, call).toBeGreaterThan(-1);
      expect(src.slice(at, at + 200), call).toContain('purgeStorefrontBlog(storeId)');
    }
  });

  it('the storefront blog fetches carry the blog:<storeId> tag the purge names', () => {
    for (const f of [
      'apps/web/src/app/blog/BlogIndexBody.tsx',
      'apps/web/src/app/blog/[slug]/BlogPostBody.tsx',
    ])
      expect(read(f), f).toContain('tags: [`blog:${storeId}`]');
  });

  it('AI autofill writes, balance revert and name repair purge after writing', () => {
    const ai = read('apps/api/src/services/ai-autofill.service.ts');
    expect(ai.match(/await invalidateStoreProductCaches\(storeId\)/g)).toHaveLength(2);
    const admin = read('apps/api/src/routes/admin.routes.ts');
    const at = admin.indexOf('repairProductNames(req.params.id');
    expect(admin.slice(at, at + 600)).toContain('invalidateStoreProductCaches(req.params.id)');
  });
});
