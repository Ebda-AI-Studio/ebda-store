import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * #2224 class sweep: the product feed used to answer EVERY upstream failure
 * with a 404 "Not found" — telling a feed consumer the store has no feed when
 * the API merely could not be asked. Only the API's own 404 is "no feed".
 */
const headerBag = new Map<string, string>();
vi.mock('next/headers', () => ({
  headers: async () => ({ get: (k: string) => headerBag.get(k) ?? null }),
}));

function stubFeed(status: number) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (String(url).includes('/public/store/resolve')) {
        return new Response(JSON.stringify({ data: { store: { id: 'store_1' } } }));
      }
      return status === 200
        ? new Response(JSON.stringify({ products: [] }), { status: 200 })
        : new Response('upstream', { status });
    })
  );
}

describe('GET /feeds/products.json — upstream failure vs genuine 404', () => {
  beforeEach(() => {
    headerBag.clear();
    headerBag.set('x-store-domain', 'p.example');
  });
  afterEach(() => vi.unstubAllGlobals());

  it.each([429, 500, 503])('upstream %i → 503 no-store, not a cacheable 404', async status => {
    stubFeed(status);
    const { GET } = await import('./route');
    const res = await GET();
    expect(res.status).toBe(503);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(res.headers.get('Retry-After')).toBe('60');
  });

  it('upstream 404 stays a 404 (control)', async () => {
    stubFeed(404);
    const { GET } = await import('./route');
    expect((await GET()).status).toBe(404);
  });

  it('upstream 200 is served with the shared edge TTL (control)', async () => {
    stubFeed(200);
    const { GET } = await import('./route');
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toContain('s-maxage=600');
  });
});
