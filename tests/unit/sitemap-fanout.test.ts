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
    // 5000 stores x 11 static pages + apex = 55,001 URLs before products.
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
      expect.objectContaining({ total: 55_001 })
    );
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

  it('re-derives the documented worst case: 851 of the 1000 ceiling, 149 spare', async () => {
    // The three caps `sitemap.ts` declares, and the measured per-store cost.
    const MAX_STORE_LIST_PAGES = 50; // fetchStores(): `if (page > 50) break`
    const HOST_RESOLVE = 1;
    const MAX_STORES_WITH_PRODUCTS = 200;
    const PER_STORE_SUBREQUESTS = 4; // 3 product pages + 1 bundle list

    const worstCase =
      MAX_STORE_LIST_PAGES + HOST_RESOLVE + MAX_STORES_WITH_PRODUCTS * PER_STORE_SUBREQUESTS;

    expect(worstCase).toBe(851);
    expect(1000 - worstCase).toBe(149);
    // Before bundles, the same arithmetic gave 651 — the comment's stated
    // "was" figure.
    expect(MAX_STORE_LIST_PAGES + HOST_RESOLVE + MAX_STORES_WITH_PRODUCTS * 3).toBe(651);
  });
});
