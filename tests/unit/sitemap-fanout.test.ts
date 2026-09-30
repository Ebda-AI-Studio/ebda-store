/**
 * Storefront sitemap — fan-out correctness (audit-followup #1146/#1162,
 * #1147/#1163, #1148/#1164).
 *
 * Three defects locked down here, all against a fetch mock that emulates the
 * REAL API contracts (live-verified 2026-09-02):
 *
 * 1. PRODUCT PAGINATION: `/public/products` hard-clamps `limit` at 100
 *    (`ProductService.listPublic`), so the old single `?limit=1000` request
 *    silently truncated every catalog to its first 100 products — in both
 *    the merchant's own submitted sitemap and the master sitemap
 *    (pecannbee: 100 of 160 live). The sitemap must page until
 *    `meta.totalPages` is exhausted.
 *
 * 2. CAP ORDER + SILENCE: `/public/stores` returns newest-first, so the
 *    200-store product cap used to keep the 200 NEWEST stores and silently
 *    drop the oldest (anchor) tenants' product URLs. Selection must be
 *    oldest-first and the drop must be logged.
 *
 * 3. PROTOCOL LIMIT: 11 static pages x 5000 stores = 55,001 URLs, past the
 *    sitemaps.org 50,000-URL-per-file hard limit — Google rejects or
 *    truncates the whole document. The sitemap must clamp to 50,000 and log.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const hostRef = { host: 'store.test' };

vi.mock('next/headers', () => ({
  headers: async () => ({ get: (k: string) => (k === 'host' ? hostRef.host : null) }),
}));
vi.mock('../../apps/web/src/lib/api', () => ({ API_URL: 'https://api.test' }));
vi.mock('../../apps/web/src/lib/structured-data', () => ({
  getSiteUrl: () => 'https://store.test',
}));

import sitemap from '../../apps/web/src/app/sitemap';

type MockWorld = {
  /** null → host is not a custom domain (master branch). */
  tenant: { id: string; slug: string } | null;
  stores: Array<{ id: string; slug: string; createdAt: string }>;
  /** productCounts[storeId] = published product count for that store. */
  productCounts: Record<string, number>;
};

function installFetchMock(world: MockWorld) {
  const fetchMock = vi.fn(async (input: string | URL) => {
    const url = new URL(String(input));
    const json = (body: unknown, ok = true) => ({
      ok,
      status: ok ? 200 : 404,
      json: async () => body,
    });

    if (url.pathname.endsWith('/public/store/resolve')) {
      if (!world.tenant) return json({}, false);
      return json({ data: { store: world.tenant } });
    }

    if (url.pathname.endsWith('/public/stores')) {
      const page = parseInt(url.searchParams.get('page') ?? '1', 10);
      const limit = Math.min(100, parseInt(url.searchParams.get('limit') ?? '10', 10));
      const start = (page - 1) * limit;
      return json({
        data: world.stores.slice(start, start + limit),
        pagination: {
          page,
          limit,
          total: world.stores.length,
          totalPages: Math.max(1, Math.ceil(world.stores.length / limit)),
        },
      });
    }

    if (url.pathname.endsWith('/public/products')) {
      // Emulate the API's REAL clamp: limit = Math.min(100, requested).
      const requested = parseInt(url.searchParams.get('limit') ?? '20', 10);
      const limit = Math.min(100, Math.max(1, requested));
      const page = Math.max(1, parseInt(url.searchParams.get('page') ?? '1', 10));
      const storeId = url.searchParams.get('storeId') ?? '';
      const total = world.productCounts[storeId] ?? 0;
      const start = (page - 1) * limit;
      const count = Math.max(0, Math.min(limit, total - start));
      const products = Array.from({ length: count }, (_, i) => ({
        slug: `${storeId}-p${start + i}`,
        updatedAt: '2026-09-01T00:00:00.000Z',
      }));
      return json({
        data: {
          products,
          meta: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
        },
      });
    }

    return json({}, false);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('sitemap fan-out', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('tenant branch pages past the API 100-product clamp (250 products -> 250 URLs)', async () => {
    hostRef.host = 'merchant.example';
    const fetchMock = installFetchMock({
      tenant: { id: 's1', slug: 'merchant' },
      stores: [],
      productCounts: { s1: 250 },
    });

    const entries = await sitemap();
    const productUrls = entries.filter(e => e.url.includes('/products/'));
    expect(productUrls).toHaveLength(250);

    const productPages = fetchMock.mock.calls
      .map(c => new URL(String(c[0])))
      .filter(u => u.pathname.endsWith('/public/products'))
      .map(u => u.searchParams.get('page'));
    expect(productPages).toEqual(['1', '2', '3']);
  });

  it('master branch gives product fan-out to the OLDEST stores when over the cap, and logs the drop', async () => {
    hostRef.host = 'store.test';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // 201 active stores, newest-first — exactly how /public/stores orders them.
    const stores = Array.from({ length: 201 }, (_, i) => ({
      id: `store-${i}`,
      slug: `slug-${i}`,
      // store-0 is the NEWEST, store-200 the OLDEST (anchor tenant).
      createdAt: new Date(Date.UTC(2026, 0, 201 - i)).toISOString(),
    }));
    const productCounts: Record<string, number> = {};
    for (const s of stores) productCounts[s.id] = 1;
    const fetchMock = installFetchMock({ tenant: null, stores, productCounts });

    const entries = await sitemap();

    const productFetchStoreIds = new Set(
      fetchMock.mock.calls
        .map(c => new URL(String(c[0])))
        .filter(u => u.pathname.endsWith('/public/products'))
        .map(u => u.searchParams.get('storeId'))
    );
    // Oldest (anchor) store keeps its catalog; the single NEWEST store is
    // the one that loses product fan-out.
    expect(productFetchStoreIds.has('store-200')).toBe(true);
    expect(productFetchStoreIds.has('store-0')).toBe(false);
    expect(productFetchStoreIds.size).toBe(200);

    // Every store still gets its static pages, capped or not.
    expect(entries.some(e => e.url === 'https://store.test/slug-0')).toBe(true);

    expect(warn).toHaveBeenCalledWith(
      'sitemap: product fan-out capped',
      expect.objectContaining({ total: 201, dropped: 1 })
    );
  });

  it('master branch clamps the document at the 50,000-URL protocol limit, loudly', async () => {
    hostRef.host = 'store.test';
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    // 5000 stores x 11 static pages = 55,000 URLs before products.
    const stores = Array.from({ length: 5000 }, (_, i) => ({
      id: `store-${i}`,
      slug: `slug-${i}`,
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, 0, i)).toISOString(),
    }));
    installFetchMock({ tenant: null, stores, productCounts: {} });

    const entries = await sitemap();
    expect(entries).toHaveLength(50_000);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('50k-URL protocol limit'),
      expect.objectContaining({ total: 55_000 })
    );
  });

  /**
   * The starvation case the 5000-store test above could never reach.
   *
   * It uses `productCounts: {}` — every store emits exactly its 11 static
   * pages — so the clamp cuts a uniform list and every store looks equally
   * treated. The real cliff needs PRODUCT-BEARING stores: each emits up to
   * 11 + 300 URLs, so ~161 of them consume the whole 50,000 budget, and with a
   * store-by-store build every store after that was emitted with ZERO URLs —
   * not "their 11 static pages still get indexed", which is what the code
   * comment and the GSC runbook both promised.
   */
  it('keeps every store’s static pages when product-bearing stores fill the budget', async () => {
    hostRef.host = 'store.test';
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    // 200 stores get the product fan-out (MAX_STORES_WITH_PRODUCTS), each with
    // a full 300-product catalog: 200 x 311 = 62,200 URLs before the other
    // stores are considered at all.
    const stores = Array.from({ length: 400 }, (_, i) => ({
      id: `store-${i}`,
      slug: `slug-${i}`,
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, 0, i)).toISOString(),
    }));
    const productCounts: Record<string, number> = {};
    for (const st of stores) productCounts[st.id] = 300;
    installFetchMock({ tenant: null, stores, productCounts });

    const entries = await sitemap();
    expect(entries).toHaveLength(50_000);

    // THE ASSERTION. Every store must still appear — its home page is the
    // first of the 11 static pages, so its absence means the store contributed
    // nothing at all.
    const urls = new Set(entries.map(e => e.url));
    const missing = stores.filter(st => !urls.has(`https://store.test/${st.slug}`));
    expect(
      missing.map(st => st.slug).slice(0, 5),
      `${missing.length} of ${stores.length} stores vanished from the master sitemap entirely`
    ).toEqual([]);

    // #1821/#1828: static pages surviving is NOT the same claim as catalog
    // pages surviving. This exact N-large + catalogs-present quadrant is the
    // one where product URLs are cut zero-or-partial for the later
    // product-bearing (still oldest-first, still anchor) stores while every
    // store's 11 static pages get in — the previously-only metric
    // (`storesFullyDropped`) reads 0 here and hides it.
    const productUrls = [...urls].filter(u => u.includes('/products/'));
    expect(
      productUrls.length,
      'no product URL survived at all in a scenario with 200 full 300-product catalogs — the fixture stopped covering this quadrant'
    ).toBeGreaterThan(0);
    expect(
      productUrls.length,
      'every product URL survived — the clamp is no longer being exercised by this fixture'
    ).toBeLessThan(200 * 300);

    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('50k-URL protocol limit'),
      expect.objectContaining({ storesWithNoCatalogUrls: expect.any(Number) })
    );
    const payload = error.mock.calls.at(-1)?.[1] as { storesWithNoCatalogUrls: number };
    expect(
      payload.storesWithNoCatalogUrls,
      'some product-bearing store must have lost its entire catalog contribution in this scenario'
    ).toBeGreaterThan(0);
  });

  it('reports how many stores were fully dropped, not just a total', async () => {
    // A total alone says truncation happened; it does not say anyone vanished.
    // With static pages emitted first, a store is fully dropped only once even
    // the cheap 11-per-store pass overflows — the point past which sharding is
    // the real answer, and an operator has to be able to see it coming.
    hostRef.host = 'store.test';
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const stores = Array.from({ length: 5000 }, (_, i) => ({
      id: `store-${i}`,
      slug: `slug-${i}`,
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, 0, i)).toISOString(),
    }));
    installFetchMock({ tenant: null, stores, productCounts: {} });

    await sitemap();

    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('50k-URL protocol limit'),
      expect.objectContaining({ storesFullyDropped: expect.any(Number) })
    );
    const payload = error.mock.calls.at(-1)?.[1] as { storesFullyDropped: number };
    // 5000 stores x 11 = 55,000 static URLs; the budget fits 4545 whole
    // stores, so 455 get nothing.
    expect(payload.storesFullyDropped).toBe(455);
  });
});

/**
 * P2-6 (final review): the platform fan-out's Cloudflare subrequest budget
 * is documented in a comment in `sitemap.ts`, and the bundle fan-out narrowed
 * it from 651 to 851 of the 1000 ceiling. A number that lives only in a
 * comment drifts the next time a per-store request is added, so measure the
 * per-store cost and re-derive the documented total here.
 */
describe('sitemap platform-branch subrequest budget', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('costs 4 subrequests per store — 3 product pages plus one bundle list', async () => {
    hostRef.host = 'platform.test';
    // 300 products = 3 pages at the API's 100 clamp, i.e. the documented
    // PRODUCT_PAGES_PER_STORE worst case.
    const fetchMock = installFetchMock({
      tenant: null,
      stores: [
        { id: 's1', slug: 'one', createdAt: '2024-01-01T00:00:00.000Z' },
        { id: 's2', slug: 'two', createdAt: '2024-01-02T00:00:00.000Z' },
      ],
      productCounts: { s1: 300, s2: 300 },
    });

    await sitemap();

    const calls = fetchMock.mock.calls.map(c => String(c[0]));
    const hostResolves = calls.filter(u => u.includes('/public/store/resolve')).length;
    const storeListPages = calls.filter(u => u.includes('/public/stores')).length;
    const perStore = (id: string) => calls.filter(u => u.includes(id)).length;

    expect(hostResolves).toBe(1);
    expect(storeListPages).toBe(1);
    expect(perStore('s1')).toBe(4);
    expect(perStore('s2')).toBe(4);
  });

  it('re-derives the documented worst case: 851 fetches, ~3,400 subrequests of the 10,000 ceiling', async () => {
    // The three caps `sitemap.ts` declares, and the measured per-store cost.
    const MAX_STORE_LIST_PAGES = 50; // fetchStores(): STORE_LIST_MAX_PAGES
    const HOST_RESOLVE = 1;
    const MAX_STORES_WITH_PRODUCTS = 200;
    const PER_STORE_SUBREQUESTS = 4; // 3 product pages + 1 bundle list

    const worstCase =
      MAX_STORE_LIST_PAGES + HOST_RESOLVE + MAX_STORES_WITH_PRODUCTS * PER_STORE_SUBREQUESTS;

    expect(worstCase).toBe(851);
    // #1271: binding calls count as subrequests. Each cached fetch also costs
    // an R2 get + put (cold) and a tag-cache lookup: <= 4 subrequests per
    // fetch. Workers Paid default ceiling is 10,000 per invocation.
    const PER_FETCH_WITH_CACHE = 4;
    expect(worstCase * PER_FETCH_WITH_CACHE).toBe(3404);
    expect(worstCase * PER_FETCH_WITH_CACHE).toBeLessThan(10_000);
    // Before bundles, the same arithmetic gave 651 — the comment's stated
    // "was" figure.
    expect(MAX_STORE_LIST_PAGES + HOST_RESOLVE + MAX_STORES_WITH_PRODUCTS * 3).toBe(651);
  });
});

describe('sitemap — master-branch contract fixes', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const twoStores = [
    { id: 's1', slug: 'one', createdAt: '2024-01-01T00:00:00.000Z' },
    { id: 's2', slug: 'two', createdAt: '2024-01-02T00:00:00.000Z' },
  ];

  // #1543
  it('does not list the platform root, which 307s to the company site', async () => {
    hostRef.host = 'store.test';
    installFetchMock({ tenant: null, stores: twoStores, productCounts: {} });
    const entries = await sitemap();
    expect(entries.map(e => e.url)).not.toContain('https://store.test/');
    expect(entries.map(e => e.url)).toContain('https://store.test/one');
  });

  // #1815 (a)
  it('logs the store-list page ceiling and counts the stores never fetched', async () => {
    hostRef.host = 'store.test';
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    // 5,200 stores → 52 pages; the ceiling stops at 50.
    const stores = Array.from({ length: 5200 }, (_, i) => ({
      id: `store-${i}`,
      slug: `slug-${i}`,
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, 0, i)).toISOString(),
    }));
    installFetchMock({ tenant: null, stores, productCounts: {} });

    await sitemap();

    expect(error).toHaveBeenCalledWith(
      'sitemap: store list page ceiling hit',
      expect.objectContaining({ fetchedPages: 50, fetched: 5000, totalPages: 52 })
    );
    const clamp = error.mock.calls.find(c => String(c[0]).includes('50k-URL protocol limit'));
    expect(clamp?.[1]).toEqual(expect.objectContaining({ storesNeverFetched: 200 }));
  });

  // #1815 (b)
  it('logs a mid-pagination store-list failure instead of shipping a short sitemap silently', async () => {
    hostRef.host = 'store.test';
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const stores = Array.from({ length: 250 }, (_, i) => ({
      id: `store-${i}`,
      slug: `slug-${i}`,
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, 0, i)).toISOString(),
    }));
    const fetchMock = installFetchMock({ tenant: null, stores, productCounts: {} });
    const real = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (input: string | URL) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/public/stores') && url.searchParams.get('page') === '2') {
        return { ok: false, status: 503, json: async () => ({}) } as never;
      }
      return real(input);
    });

    const entries = await sitemap();

    expect(entries.some(e => e.url === 'https://store.test/slug-0')).toBe(true);
    expect(error).toHaveBeenCalledWith(
      'sitemap: store list fetch failed mid-pagination',
      expect.objectContaining({ page: 2, status: 503, fetchedSoFar: 100 })
    );
  });

  // #1271
  it('counts stores whose product fan-out threw instead of dropping them silently', async () => {
    hostRef.host = 'store.test';
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetchMock = installFetchMock({
      tenant: null,
      stores: twoStores,
      productCounts: { s1: 1, s2: 1 },
    });
    const real = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (input: string | URL) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/public/products') && url.searchParams.get('storeId') === 's2') {
        throw new Error('Too many subrequests.');
      }
      return real(input);
    });

    const entries = await sitemap();

    // The failed store keeps its static pages.
    expect(entries.some(e => e.url === 'https://store.test/two')).toBe(true);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('product fan-out failed'),
      expect.objectContaining({ failedStores: 1, attempted: 2 })
    );
  });
});

// #2127 — "could not ask" must 5xx (Google keeps the last-good sitemap), never
// serve a 200 empty <urlset/> that overwrites it.
describe('sitemap — could-not-ask vs genuinely empty', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  function stubWith(handler: (url: URL) => { ok: boolean; status: number; body?: unknown }) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL) => {
        const r = handler(new URL(String(input)));
        return { ok: r.ok, status: r.status, json: async () => r.body ?? {} };
      })
    );
  }

  it('master branch: page-1 store-list failure throws instead of returning []', async () => {
    hostRef.host = 'store.test';
    stubWith(u =>
      u.pathname.endsWith('/public/store/resolve')
        ? { ok: false, status: 404 }
        : { ok: false, status: 503 }
    );
    await expect(sitemap()).rejects.toThrow(/sitemap source unavailable/);
  });

  it('master branch: a thrown store-list fetch propagates (5xx), not []', async () => {
    hostRef.host = 'store.test';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL) => {
        if (String(input).includes('/public/store/resolve')) {
          return { ok: false, status: 404, json: async () => ({}) };
        }
        throw new Error('ECONNRESET');
      })
    );
    await expect(sitemap()).rejects.toThrow();
  });

  it('master branch: a successful answer of zero stores is a legitimately empty sitemap', async () => {
    hostRef.host = 'store.test';
    installFetchMock({ tenant: null, stores: [], productCounts: {} });
    await expect(sitemap()).resolves.toEqual([]);
  });

  it('host resolve failing (not 404) does not fall through to the platform sitemap', async () => {
    hostRef.host = 'merchant.example';
    stubWith(u =>
      u.pathname.endsWith('/public/store/resolve')
        ? { ok: false, status: 429 }
        : { ok: true, status: 200, body: { data: [], pagination: { totalPages: 1 } } }
    );
    await expect(sitemap()).rejects.toThrow(/host resolve/);
  });

  it('tenant branch: a products page-1 failure fails the render instead of dropping every product URL', async () => {
    hostRef.host = 'merchant.example';
    stubWith(u => {
      if (u.pathname.endsWith('/public/store/resolve')) {
        return { ok: true, status: 200, body: { data: { store: { id: 's1', slug: 'm' } } } };
      }
      if (u.pathname.endsWith('/public/products')) return { ok: false, status: 503 };
      return { ok: false, status: 404 };
    });
    await expect(sitemap()).rejects.toThrow(/products page 1/);
  });
});
