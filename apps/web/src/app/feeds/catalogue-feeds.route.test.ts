import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** Storefront passthrough for /feeds/google.xml|meta.xml|tiktok.csv: validation at the edge, fail-closed, no false 404. */
const headerBag = new Map<string, string>();
vi.mock('next/headers', () => ({
  headers: async () => ({ get: (k: string) => headerBag.get(k) ?? null }),
}));

const upstreamCalls: string[] = [];
function stub(status: number, body = '<rss/>') {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (String(url).includes('/public/store/resolve'))
        return new Response(JSON.stringify({ data: { store: { id: 'store_1', slug: 'shop' } } }));
      upstreamCalls.push(String(url));
      return new Response(body, {
        status,
        headers: { 'content-type': 'application/xml; charset=utf-8', 'x-feed-next-part': '2' },
      });
    })
  );
}
const req = (path: string) => new Request(`https://shop.example${path}`);

describe('catalogue feed passthrough', () => {
  beforeEach(() => {
    headerBag.clear();
    headerBag.set('x-store-domain', 'shop.example');
    upstreamCalls.length = 0;
  });
  afterEach(() => vi.unstubAllGlobals());

  it('404 without a store host; 400 on a bad lang or part before any upstream call', async () => {
    const { serveCatalogueFeed } = await import('../../lib/catalogue-feed-route');
    headerBag.delete('x-store-domain');
    expect((await serveCatalogueFeed('google.xml', req('/feeds/google.xml'))).status).toBe(404);
    headerBag.set('x-store-domain', 'shop.example');
    stub(200);
    expect((await serveCatalogueFeed('google.xml', req('/feeds/google.xml?lang=fr'))).status).toBe(
      400
    );
    expect((await serveCatalogueFeed('google.xml', req('/feeds/google.xml?part=0'))).status).toBe(
      400
    );
    expect(upstreamCalls).toHaveLength(0);
  });

  it('forwards lang/part to the platform file, keeps content type and next-part header', async () => {
    stub(200);
    const { serveCatalogueFeed } = await import('../../lib/catalogue-feed-route');
    const res = await serveCatalogueFeed('tiktok.csv', req('/feeds/tiktok.csv?lang=en&part=2'));
    expect(res.status).toBe(200);
    expect(upstreamCalls[0]).toContain('/public/feed/tiktok.csv?lang=en&part=2');
    expect(res.headers.get('X-Feed-Next-Part')).toBe('2');
    expect(res.headers.get('Content-Type')).toContain('application/xml');
  });

  it.each([429, 500, 503])('upstream %i -> 503 no-store, never a cacheable 404', async status => {
    stub(status);
    const { serveCatalogueFeed } = await import('../../lib/catalogue-feed-route');
    const res = await serveCatalogueFeed('meta.xml', req('/feeds/meta.xml'));
    expect(res.status).toBe(503);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  it('the API 404 (feature off / no such part) stays a 404', async () => {
    stub(404);
    const { serveCatalogueFeed } = await import('../../lib/catalogue-feed-route');
    expect((await serveCatalogueFeed('google.xml', req('/feeds/google.xml'))).status).toBe(404);
  });
});
