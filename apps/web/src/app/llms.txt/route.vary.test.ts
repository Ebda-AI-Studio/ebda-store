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
    if (url.includes('/public/stores/')) {
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
  beforeEach(() => {
    headerBag.clear();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('URL slug segment: public + s-maxage + Vary: Cookie', async () => {
    headerBag.set('x-store-slug', 'test-store');
    // No x-store-slug-source — this came from the URL, not the cookie fallback.
    mockStoreFetches();

    const { GET } = await import('./route');
    const res = await GET();

    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe(
      'public, s-maxage=600, stale-while-revalidate=86400'
    );
    expect(res.headers.get('vary')).toBe('Cookie');
  });

  it('cookie fallback (bare /llms.txt, sticky cookie): private, no shared-cache directive, no Vary', async () => {
    headerBag.set('x-store-slug', 'test-store');
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
