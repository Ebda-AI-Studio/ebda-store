import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * audit-followup #1732 (scoped-audit P2 follow-up on PR #1942, same class as
 * acp.json/ucp): `GET` serves the per-store body whenever the `x-store-slug`
 * header is set — and middleware sets that header from the sticky
 * `x-store-slug` COOKIE, not just the URL, for a bare `/llms.txt` request
 * with no slug segment. When resolved via that cookie fallback (signalled by
 * middleware's `x-store-slug-source: cookie` header), the response must NOT
 * be shared-cacheable — `Vary: Cookie` alone doesn't stop a Cloudflare edge
 * cache from replaying one visitor's cookie-resolved store to another (its
 * cache ignores Vary outside an Enterprise-only feature — see
 * apps/api/src/lib/edge-cache.ts). A URL slug segment or custom-domain Host
 * resolution stays public+s-maxage with Vary: Cookie.
 */

const headerBag = new Map<string, string>();

vi.mock('next/headers', () => ({
  headers: async () => ({ get: (k: string) => headerBag.get(k) ?? null }),
}));

const fetchMock = vi.fn();

function jsonResponse(body: unknown, ok = true) {
  return { ok, json: async () => body };
}

function mockStoreFetches() {
  fetchMock.mockImplementation((url: string) => {
    if (url.includes('/public/store/resolve') || url.includes('/public/stores/')) {
      return Promise.resolve(
        jsonResponse({
          data: {
            store: { id: 'store_1', slug: 'test-store', status: 'active', llmsTxt: 'Hello.' },
            enabledFeatures: [],
          },
        })
      );
    }
    if (url.includes('/public/categories')) {
      return Promise.resolve(jsonResponse({ data: { categories: [] } }));
    }
    return Promise.resolve(jsonResponse({ data: { products: [] } }));
  });
}

describe('GET /llms.txt — shared-cacheability by resolution source', () => {
  it('an unresolvable store host is a 404, never the platform index', async () => {
    headerBag.clear();
    headerBag.set('x-store-domain', 'nobody.ebda.app');
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({ ok: false, status: 404, json: async () => ({}) });
    vi.stubGlobal('fetch', fetchMock);
    const { GET } = await import('./route');
    const res = await GET();
    expect(res.status).toBe(404);
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    headerBag.clear();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('store host: public + s-maxage + Vary: Cookie', async () => {
    headerBag.set('x-store-domain', 'test-store.ebda.app');
    // No x-store-slug-source — this came from the Host, not a cookie fallback.
    mockStoreFetches();

    const { GET } = await import('./route');
    const res = await GET();

    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe(
      'public, s-maxage=600, stale-while-revalidate=86400'
    );
    expect(res.headers.get('vary')).toBe('Cookie');
  });

  it('a non-URL identity signal (retired cookie fallback): private, no shared-cache directive, no Vary', async () => {
    headerBag.set('x-store-domain', 'test-store.ebda.app');
    headerBag.set('x-store-slug-source', 'cookie');
    mockStoreFetches();

    const { GET } = await import('./route');
    const res = await GET();

    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, max-age=600');
    expect(res.headers.get('cache-control')).not.toMatch(/s-maxage/);
    expect(res.headers.get('vary')).toBeNull();
  });
});
