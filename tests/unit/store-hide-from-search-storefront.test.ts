/**
 * "Hide my store from search engines" on the storefront: page robots meta, robots.txt, sitemap.xml and llms.txt all obey
 * `store.settings.hideFromSearchEngines`, on the platform host and on a custom domain, and the fetches that feed
 * them carry the `store-domain:<host>` tag the API purges on the toggle. Cart/checkout stay untouched.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const req = vi.hoisted(() => ({
  host: 'shop.ebda.app',
  storeDomain: 'shop.ebda.app' as string | null,
}));
vi.mock('next/headers', () => ({
  headers: async () => ({
    get: (k: string) => (k === 'host' ? req.host : k === 'x-store-domain' ? req.storeDomain : null),
  }),
}));
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NOT_FOUND');
  },
}));
vi.mock('../../apps/web/src/lib/api', () => ({ API_URL: 'https://api.test' }));

import robots from '../../apps/web/src/app/robots';
import sitemap from '../../apps/web/src/app/sitemap';
import { buildStorefrontMetadata } from '../../apps/web/src/lib/storefront-metadata';
import { perStoreResponse } from '../../apps/web/src/app/llms.txt/route';

function stubApi(settings: Record<string, unknown>) {
  const fetchMock = vi.fn(async (input: string | URL) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/public/store/resolve'))
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: { store: { id: 's1', slug: 'shop', settings } } }),
      };
    if (url.pathname.endsWith('/public/products'))
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: { products: [{ slug: 'p1' }], meta: { totalPages: 1 } } }),
      };
    return { ok: false, status: 404, json: async () => ({}) };
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const store = (settings: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  ({
    id: 's1',
    slug: 'shop',
    name: 'Shop',
    status: 'active',
    currency: 'EGP',
    settings,
    ...extra,
  }) as never;

// Mirrors robots.ts: bare roots plus the locale-served twins (#647).
const PRIVATE_ROOTS = ['/account/', '/checkout/', '/cart/', '/auth/', '/affiliate/'];

describe.each([
  ['platform host', 'shop.ebda.app'],
  ['custom domain', 'shop.example'],
])('hide from search on a %s', (_label, host) => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    req.host = req.storeDomain = host;
  });

  it('robots.txt: crawlable (so the meta is read), private paths disallowed, no sitemap', async () => {
    const fetchMock = stubApi({ hideFromSearchEngines: true });
    const r = await robots();
    expect(r.sitemap).toBeUndefined();
    expect(r.rules).toEqual([
      {
        userAgent: '*',
        allow: '/',
        disallow: [
          ...PRIVATE_ROOTS,
          ...PRIVATE_ROOTS.map(p => `/ar${p}`),
          ...PRIVATE_ROOTS.map(p => `/en${p}`),
        ],
      },
    ]);
    expect(JSON.stringify(r.rules)).not.toContain('"disallow":"/"');
    // purge-reachable: tagged with the host tag the API purges
    expect((fetchMock.mock.calls[0][1] as any).next.tags).toContain(`store-domain:${host}`);
  });

  it('robots.txt: flag OFF or absent keeps the sitemap', async () => {
    for (const s of [{}, { hideFromSearchEngines: false }]) {
      stubApi(s);
      expect((await robots()).sitemap).toBe(`https://${host}/sitemap.xml`);
    }
  });

  it('sitemap.xml: no URLs, no product fetch; OFF lists the store', async () => {
    const on = stubApi({ hideFromSearchEngines: true });
    await expect(sitemap()).resolves.toEqual([]);
    expect(on.mock.calls.some(c => String(c[0]).includes('/public/products'))).toBe(false);
    expect((on.mock.calls[0][1] as any).next.tags).toContain(`store-domain:${host}`);

    stubApi({});
    expect((await sitemap()).length).toBeGreaterThan(0);
  });

  it('llms.txt: 404 + noindex when hidden', async () => {
    const res = await perStoreResponse(
      { ...(store({ hideFromSearchEngines: true }) as object) } as never,
      false,
      host
    );
    expect(res.status).toBe(404);
    expect(res.headers.get('X-Robots-Tag')).toBe('noindex');
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });
});

describe('page metadata robots', () => {
  it('noindex,nofollow when hidden; index,follow when off or absent', () => {
    const robotsOf = (s: Record<string, unknown>) =>
      (buildStorefrontMetadata(store(s), false, 'ar') as any).robots;
    expect(robotsOf({ hideFromSearchEngines: true })).toEqual({ index: false, follow: false });
    expect(robotsOf({ hideFromSearchEngines: false })).toEqual({ index: true, follow: true });
    expect(robotsOf({})).toEqual({ index: true, follow: true });
  });
});
