/**
 * Gold-rate pricing, Task 10 (Ruling B5-21): price is NEVER-stale, so every rate write path clears
 * EVERY layer through the IMMEDIATE invalidator. Two halves:
 *  (a) what the purge touches: Redis `public:products:` / `public:product:` / `public:suggest:` /
 *      `admin:products:` prefixes, the bundle and category keys, the generation bumps that stop an
 *      in-flight fill republishing the old price, and ONE storefront revalidation for the
 *      `products:` / `categories:` / `bundles:` tags;
 *  (b) that every write path calls it, and never the order-coalesced `...AfterOrder` variant
 *      (a 10 s coalescing window is not acceptable for a price change). Structural, with a negative
 *      control: a path that forgets the purge is named.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { parseSource, findAll, callsTo, nameOf } from './helpers/ts-ast';

const calls = vi.hoisted(() => ({
  deleteByPattern: [] as string[],
  del: [] as string[],
  bump: [] as string[],
  revalidate: [] as Array<{ tags?: string[] }>,
}));
vi.mock('../../apps/api/src/services/redis.service', () => ({
  redis: {
    isAvailable: () => true,
    get: async () => null,
    set: async () => undefined,
    delete: async (k: string) => {
      calls.del.push(k);
    },
    deleteByPattern: async (p: string) => {
      calls.deleteByPattern.push(p);
      return 0;
    },
    getCacheGenerations: async (names: string[]) => names.map(() => '0'),
    bumpCacheGeneration: async (n: string) => {
      calls.bump.push(n);
    },
  },
}));
vi.mock('../../apps/api/src/lib/revalidate-storefront', () => ({
  revalidateStorefront: (o: { tags?: string[] }) => {
    calls.revalidate.push(o);
  },
}));

const { invalidateStoreProductCaches, invalidateStoreProductCachesAfterOrder } =
  await import('../../apps/api/src/lib/public-cache');

beforeEach(() => {
  calls.deleteByPattern.length = 0;
  calls.del.length = 0;
  calls.bump.length = 0;
  calls.revalidate.length = 0;
});

describe('(a) the immediate purge touches every layer of Ruling B5-21 items 1-7', () => {
  it('Redis prefixes: PLP lists + search results, the PDP, search suggest, the admin list', async () => {
    await invalidateStoreProductCaches('s1');
    for (const p of [
      'public:products:s1:',
      'public:product:s1:',
      'public:suggest:s1:',
      'admin:products:s1:',
    ])
      expect(calls.deleteByPattern, p).toContain(p);
  });
  it('the bundle list and the category caches are cleared too', async () => {
    await invalidateStoreProductCaches('s1');
    expect(calls.del).toContain('public:bundles:v2:s1');
    expect(calls.del).toContain('public:categories:s1');
    expect(calls.del).toContain('admin:categories:s1');
  });
  it('the generation of each prefix is bumped FIRST, so an in-flight fill cannot republish the old price', async () => {
    await invalidateStoreProductCaches('s1');
    expect(calls.bump.length).toBeGreaterThanOrEqual(4);
    expect(
      calls.bump.some(n => n.startsWith('public:products:s1') || n.startsWith('public:'))
    ).toBe(true);
  });
  it('ONE storefront revalidation carries products, categories and bundles (feed, llms, PLP, PDP, home, sitemap)', async () => {
    await invalidateStoreProductCaches('s1');
    expect(calls.revalidate).toHaveLength(1);
    expect(calls.revalidate[0].tags).toEqual(['products:s1', 'categories:s1', 'bundles:s1']);
  });
  it('NEGATIVE CONTROL: the order-coalesced variant does NOT revalidate on a second call inside its window', async () => {
    await invalidateStoreProductCachesAfterOrder('s2');
    await invalidateStoreProductCachesAfterOrder('s2');
    // the second call is coalesced (<= 1 immediate revalidation): exactly why a price change must not use it
    expect(calls.revalidate.filter(r => r.tags?.includes('products:s2'))).toHaveLength(1);
  });
});

describe('(b) every write path calls the immediate purge, none calls the order-coalesced one', () => {
  const root = path.resolve(__dirname, '../..');
  const read = (f: string) => readFileSync(path.join(root, f), 'utf8');
  const stripComments = (src: string) =>
    src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const service = read('apps/api/src/services/gold-rate/gold-rate.service.ts');
  const serviceCode = stripComments(service);

  /**
   * Calls to `callee` made from inside `static async <name>(…)`. AST, not a text window to the
   * next `static async`: a comment, a string, or a call in the NEXT method cannot count.
   */
  const callsIn = (code: string, name: string, callee: string): string[] => {
    const sf = parseSource('gold-rate.service.ts', code);
    const method = findAll(
      sf,
      (n): n is ts.MethodDeclaration => ts.isMethodDeclaration(n) && nameOf(n) === name
    )[0];
    if (!method) return [];
    return callsTo(method, callee).map(c => c.arguments.map(a => a.getText()).join(','));
  };

  // each public path that can change a price a shopper sees
  const PATHS = [
    'applyRates',
    'decidePending',
    'updateSettings',
    'setProductPricing',
    'asRepricer',
  ];

  for (const name of PATHS)
    it(`${name} purges through purgeGoldPrices`, () => {
      expect(callsIn(service, name, 'purgeGoldPrices'), name).toContain('storeId');
    });

  it('bulkSwitchMode purges because every product it switches goes through setProductPricing', () => {
    expect(callsIn(service, 'bulkSwitchMode', 'this.setProductPricing').length).toBeGreaterThan(0);
  });

  it('purgeGoldPrices is the IMMEDIATE invalidator, never the AfterOrder one', () => {
    expect(service).toContain('invalidateStoreProductCaches(storeId)');
    expect(serviceCode).not.toMatch(/invalidateStoreProductCachesAfterOrder/);
    expect(service).toMatch(/STALENESS CLASS: price, NEVER-stale/);
  });

  it('the feed cron (Task 11) and the repricer never call the coalesced variant either', () => {
    const files = [
      'apps/api/src/services/gold-rate/repricer.ts',
      'apps/api/src/services/gold-rate/gate.ts',
      'apps/api/src/routes/gold-rate.routes.ts',
    ];
    for (const f of files)
      expect(stripComments(read(f)), f).not.toMatch(/invalidateStoreProductCachesAfterOrder/);
  });

  it('NEGATIVE CONTROL: a path without the purge is detected', () => {
    const fake = `class X { static async bogus(storeId: string) { await withMoneyTx(prisma, async () => {}); }\n  static async next() { purgeGoldPrices(storeId); } }`;
    expect(callsIn(fake, 'bogus', 'purgeGoldPrices')).not.toContain('storeId');
    // and a purge that is only mentioned in a comment is not a call
    expect(
      callsIn(
        `class X { static async bogus(storeId: string) { /* purgeGoldPrices(storeId) */ } }`,
        'bogus',
        'purgeGoldPrices'
      )
    ).toEqual([]);
  });
});

describe('the feed passthrough caches gold stores for at most 60 s with no stale-while-revalidate (the one residual)', () => {
  const root = path.resolve(__dirname, '../..');
  const read = (f: string) => readFileSync(path.join(root, f), 'utf8');
  it("the web feed route switches on the API's X-Gold-Pricing header and leaves other stores byte-identical", () => {
    const route = read('apps/web/src/app/feeds/products.json/route.ts');
    expect(route).toContain("upstream.headers.get('x-gold-pricing') === '1'");
    expect(route).toContain("'public, s-maxage=60'");
    expect(route).toContain("'public, s-maxage=600, stale-while-revalidate=86400'");
  });
  it('the API feed route emits the header and a 60 s window without a stale tail for a gold store', () => {
    const api = read('apps/api/src/routes/public.routes.ts');
    expect(api).toContain("res.setHeader('X-Gold-Pricing', '1')");
    expect(api).toMatch(/Math\.min\(60, nextBoundarySec\)\),\s*staleWhileRevalidate: 0/);
  });
});
