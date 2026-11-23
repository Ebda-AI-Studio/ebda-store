/**
 * Storefront sitemap — per-store, host-keyed fan-out.
 *
 * Every store has its own host, and `/sitemap.xml` lists ONLY that store's URLs
 * rooted at that host (`x-store-domain`, asserted by middleware). There is no
 * master sitemap over every store under `/<slug>/…` any more: the apex and other
 * platform hosts list nothing, and a store host that resolves to no store is a
 * 404. What stays locked down here, against a fetch mock that emulates the REAL
 * API contracts (live-verified 2026-09-02):
 *
 * - PRODUCT PAGINATION: `/public/products` hard-clamps `limit` at 100
 *   (`ProductService.listPublic`), so the sitemap must page until
 *   `meta.totalPages` is exhausted (demo-store: 100 of 160 live was the bug).
 * - COULD-NOT-ASK vs EMPTY (#2127): a 5xx from the API fails the render so
 *   Google keeps its last-good copy, instead of a 200 empty `<urlset/>`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const hostRef = { host: 'merchant.example' };

const NOT_FOUND = vi.hoisted(() => new Error('NEXT_NOT_FOUND'));
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw NOT_FOUND;
  },
}));
vi.mock('next/headers', () => ({
  // `host` is a platform host unless a test names a store host: an EMPTY value
  // models the absent `x-store-domain` header on the apex.
  headers: async () => ({
    get: (k: string) => (k === 'x-store-domain' && hostRef.host ? hostRef.host : null),
  }),
}));
vi.mock('../../apps/web/src/lib/api', () => ({ API_URL: 'https://api.test' }));

import sitemap from '../../apps/web/src/app/sitemap';

type MockWorld = {
  /** null → host is not a custom domain (master branch). */
  tenant: { id: string; slug: string; isDemo?: boolean } | null;
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
      return json({ success: true, data: { store: world.tenant } });
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

  it('R1: a custom domain whose host resolve fails on a COLD hit once is served from the last-known-good copy, not a 500', async () => {
    hostRef.host = 'warm-merchant.example';
    const ok = (u: URL) =>
      u.pathname.endsWith('/public/store/resolve')
        ? {
            ok: true,
            status: 200,
            body: { success: true, data: { store: { id: 'w1', slug: 'warm' } } },
          }
        : { ok: true, status: 200, body: { data: [], pagination: { totalPages: 1 } } };
    stubWith(ok);
    await sitemap(); // the host resolves and its copy is kept
    // the API is now cold / limited: 429 on the resolve
    stubWith(u =>
      u.pathname.endsWith('/public/store/resolve') ? { ok: false, status: 429 } : ok(u)
    );
    await expect(sitemap()).resolves.toBeDefined();
  });

  it('host resolve failing (not 404) does not fall through to the platform sitemap', async () => {
    hostRef.host = 'merchant-down.example';
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
        return {
          ok: true,
          status: 200,
          body: { success: true, data: { store: { id: 's1', slug: 'm' } } },
        };
      }
      if (u.pathname.endsWith('/public/products')) return { ok: false, status: 503 };
      return { ok: false, status: 404 };
    });
    await expect(sitemap()).rejects.toThrow(/products page 1/);
  });
});

describe('sitemap — host routing', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('a platform host (no x-store-domain) lists nothing and asks the API nothing', async () => {
    hostRef.host = '';
    const fetchMock = installFetchMock({ tenant: null, stores: [], productCounts: {} });
    await expect(sitemap()).resolves.toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a store host that resolves to no store is a 404, not another store’s URLs', async () => {
    hostRef.host = 'nobody.ebda.app';
    installFetchMock({
      tenant: null,
      stores: [{ id: 's1', slug: 'other', createdAt: '2026-01-01T00:00:00.000Z' }],
      productCounts: { s1: 3 },
    });
    await expect(sitemap()).rejects.toBe(NOT_FOUND);
  });

  it('B1-14: the demo showroom host lists nothing and asks for no products', async () => {
    hostRef.host = 'storedemo.ebda.app';
    const fetchMock = installFetchMock({
      tenant: { id: 's1', slug: 'storedemo', isDemo: true },
      stores: [],
      productCounts: { s1: 40 },
    });
    await expect(sitemap()).resolves.toEqual([]);
    const asked = fetchMock.mock.calls.map(c => new URL(String(c[0])).pathname);
    expect(asked.some(p => p.endsWith('/public/products'))).toBe(false);
  });

  it('a <slug>.ebda.app host lists only its own store, rooted at that host', async () => {
    hostRef.host = 'demo-boutique.ebda.app';
    installFetchMock({
      tenant: { id: 's1', slug: 'demo-boutique' },
      stores: [{ id: 's2', slug: 'other', createdAt: '2026-01-01T00:00:00.000Z' }],
      productCounts: { s1: 2, s2: 9 },
    });
    const entries = await sitemap();
    expect(entries.length).toBeGreaterThan(0);
    for (const e of entries) {
      expect(e.url.startsWith('https://demo-boutique.ebda.app')).toBe(true);
      expect(e.url).not.toContain('/demo-boutique/');
      expect(e.url).not.toContain('s2-p');
    }
    expect(entries.filter(e => e.url.includes('/products/'))).toHaveLength(2);
  });
});
