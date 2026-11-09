/**
 * S2-REVIVE (Ruling STORE-EDGE-2): every NEVER-stale write class reaches the storefront HTML edge cache.
 *
 * The chain under test, end to end with the real code on both sides of the Worker boundary:
 *   API invalidator (real) -> revalidateStorefront (real, builds the tags) -> the POST body the storefront Worker gets
 *   -> bumpEpochs (real, web Worker) -> a stored page of THAT store is no longer served, another store's still is.
 *
 * Which write path calls which invalidator is pinned by the existing per-path tests, named per class below:
 *   price change      -> invalidateStoreProductCaches   (variant-cache-invalidation, product-model-routes, on-sale-cache-class)
 *   stock change      -> invalidateStoreProductCaches / ...AfterOrder (warehouse-stock-write-retry, order-rollback-bundle-restore)
 *   gold reprice      -> purgeGoldPrices -> invalidateStoreProductCaches (gold-rate-cache-layers)
 *   store suspend     -> bustStoreCaches (ProvisioningService.updateStoreStatus, admin PUT, billing suspend)
 *   theme publish     -> bustStoreCaches (page-builder publish, layout-save-purges-storefront-cache)
 *   category write    -> invalidateStoreCategoriesCaches (this PR; source guard at the bottom)
 * Mutation-proof: drop a tag from an invalidator, or map a tag to the wrong epoch key, and the matching case reddens.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
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
vi.mock('../../apps/api/src/lib/store-directory', () => ({
  invalidateStoreDirectory: async () => undefined,
}));

const {
  invalidateStoreProductCaches,
  invalidateStoreProductCachesAfterOrder,
  invalidateStoreCategoriesCaches,
} = await import('../../apps/api/src/lib/public-cache');
const { bustStoreCaches } = await import('../../apps/api/src/services/store.service');
const { bumpEpochs, isEntryCurrent, resetEpochMemo } =
  await import('../../apps/web/store-edge-cache');

const A = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', slug: 'shop-a', domain: 'shop-a.example' };
const B = { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', slug: 'shop-b', domain: 'shop-b.example' };

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

let posts: string[][];
let r2: MapR2;
const RENDERED_AT = 1_000_000;
const PURGED_AT = RENDERED_AT + 60_000;
const NOW = PURGED_AT + 1_000;

beforeEach(() => {
  posts = [];
  r2 = new MapR2();
  resetEpochMemo();
  process.env.STOREFRONT_REVALIDATE_URL = 'https://storefront.test';
  process.env.REVALIDATE_SECRET = 'test-secret';
  vi.stubGlobal('fetch', async (_url: string, init: { body: string }) => {
    posts.push((JSON.parse(init.body) as { tags: string[] }).tags);
    return new Response('{}', { status: 200 });
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

/** What the storefront Worker does with every purge POST it receives. */
async function deliver(): Promise<void> {
  // revalidateStorefront is fire-and-forget: let the queued fetch run.
  await new Promise(r => setTimeout(r, 0));
  expect(posts.length, 'the write path sent no storefront purge').toBeGreaterThan(0);
  for (const tags of posts) await bumpEpochs(r2, tags, PURGED_AT);
}

/** Every host a store's pages are cached under: its free subdomain and its custom domain. */
const entries = (s: typeof A) => [
  { at: RENDERED_AT, host: `${s.slug}.ebda.app`, id: s.id },
  { at: RENDERED_AT, host: s.domain, id: s.id },
];

async function expectInvalidated(s: typeof A, other: typeof B) {
  for (const e of entries(s)) expect(await isEntryCurrent(r2, e, NOW), e.host).toBe(false);
  for (const e of entries(other)) expect(await isEntryCurrent(r2, e, NOW), e.host).toBe(true);
}

describe('each NEVER-stale write class drops that store from the HTML edge cache, and only that store', () => {
  it('price change (product/variant write)', async () => {
    await invalidateStoreProductCaches(A.id);
    await deliver();
    await expectInvalidated(A, B);
  });
  it('stock change from an order (coalesced purge, first one in the window)', async () => {
    await invalidateStoreProductCachesAfterOrder(A.id);
    await deliver();
    await expectInvalidated(A, B);
  });
  it('gold reprice (purgeGoldPrices runs invalidateStoreProductCaches)', async () => {
    const src = readFileSync(
      path.resolve(__dirname, '../../apps/api/src/services/gold-rate/gold-rate.service.ts'),
      'utf8'
    );
    expect(src).toMatch(
      /function purgeGoldPrices[\s\S]{0,200}invalidateStoreProductCaches\(storeId\)/
    );
    await invalidateStoreProductCaches(A.id);
    await deliver();
    await expectInvalidated(A, B);
  });
  it('store suspend / status change (bustStoreCaches)', async () => {
    await bustStoreCaches(A.id, A.slug, A.domain);
    await deliver();
    await expectInvalidated(A, B);
  });
  it('theme / layout publish (bustStoreCaches carries layout:<id>)', async () => {
    await bustStoreCaches(A.id, A.slug, null);
    await deliver();
    expect(posts.flat()).toContain(`layout:${A.id}`);
    // A theme publish on a store with no custom domain still reaches its custom-domain pages through layout:<id>.
    await expectInvalidated(A, B);
  });
  it('category write (BOUNDED-stale, same purge)', async () => {
    await invalidateStoreCategoriesCaches(A.id);
    await deliver();
    await expectInvalidated(A, B);
  });
});

describe('source guard: a category write never clears only the API cache', () => {
  it('every API-only public:categories clear is followed by a storefront purge', () => {
    const root = path.resolve(__dirname, '../../apps/api/src');
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = path.join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.ts$/.test(name) && !/\.test\.ts$/.test(name)) {
          const src = readFileSync(p, 'utf8');
          if (!src.includes('invalidateCached(`public:categories:')) continue;
          if (p.endsWith(path.join('lib', 'public-cache.ts'))) continue;
          if (p.endsWith(path.join('services', 'store.service.ts'))) continue; // bustStoreCaches purges itself
          // Each API-only clear must be followed closely by a purge that carries the storefront tag.
          const marker = 'invalidateCached(`public:categories:';
          for (let i = src.indexOf(marker); i !== -1; i = src.indexOf(marker, i + 1)) {
            if (!/invalidateStore(Categories|Product)Caches\(/.test(src.slice(i, i + 400)))
              offenders.push(`${path.relative(root, p)}@${src.slice(0, i).split('\n').length}`);
          }
        }
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});
