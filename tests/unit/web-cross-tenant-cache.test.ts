/**
 * SP4 / Review Focus 1 — storefront tenant isolation across `<slug>.ebda.app`
 * and custom domains, including the caches.
 *
 * Two layers are exercised end to end with NO mocks of the code under test:
 *
 *  1. `middleware()` — the Host (and only the Host) picks the store; the tenant
 *     tree's route key (the thing Next's full-route cache and OpenNext's R2
 *     incremental cache are keyed on) carries the HOST, so store A's HTML at a
 *     path can never be served for store B at the same path. The apex and other
 *     platform hosts never resolve a store; a malformed host is a 404.
 *  2. `store-resolver` — the in-process store cache and the Next data-cache
 *     fetches are keyed on the host: A then B at the same path each get their
 *     own store, including after A is cached, and an unknown host asked right
 *     after a known one is a 404 (no stale store, no default store).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { middleware } from '../../apps/web/middleware';
import { redirectTarget } from '../../apps/web/studio-host';

const NOT_FOUND = vi.hoisted(() => new Error('NEXT_NOT_FOUND'));
const headerBag = vi.hoisted(() => ({ value: new Map<string, string>() }));

vi.mock('next/navigation', () => ({
  notFound: () => {
    throw NOT_FOUND;
  },
}));
vi.mock('next/headers', () => ({
  headers: async () => ({ get: (k: string) => headerBag.value.get(k.toLowerCase()) ?? null }),
}));

// ─── 1. middleware ──────────────────────────────────────────────────────────

const rewriteOf = (res: Response) => res.headers.get('x-middleware-rewrite') ?? '';
const forwarded = (res: Response, name: string) => res.headers.get(`x-middleware-request-${name}`);
const at = (host: string, path: string, headers: Record<string, string> = {}) =>
  new NextRequest(`https://${host}${path}`, { headers: { host, ...headers } });

describe('middleware — the Host alone picks the store', () => {
  const ENV = { ...process.env };
  beforeEach(() => {
    process.env.STOREFRONT_TENANT_ROUTING = 'true';
    process.env.STOREFRONT_TENANT_ROUTING_ROUTES = 'all';
    process.env.STOREFRONT_TENANT_ROUTING_STORES = 'amelia,demo-boutique,ameliaaurum.com';
  });
  afterEach(() => {
    process.env = { ...ENV };
  });

  it('store A and store B at the SAME path get DIFFERENT tenant route keys (cache key includes the host)', () => {
    const a = rewriteOf(middleware(at('amelia.ebda.app', '/products')));
    const b = rewriteOf(middleware(at('demo-boutique.ebda.app', '/products')));
    const custom = rewriteOf(middleware(at('ameliaaurum.com', '/products')));
    expect(new URL(a).pathname).toBe('/tenant-store/amelia.ebda.app/en/products');
    expect(new URL(b).pathname).toBe('/tenant-store/demo-boutique.ebda.app/en/products');
    expect(new URL(custom).pathname).toBe('/tenant-store/ameliaaurum.com/en/products');
    expect(new Set([a, b, custom]).size).toBe(3);
  });

  it('a request’s tenant key can never be steered by cookie, header or query to another store', () => {
    const res = middleware(
      at('demo-boutique.ebda.app', '/products?store=amelia&slug=amelia', {
        cookie: 'x-store-slug=amelia',
        'x-store-slug': 'amelia',
        'x-store-domain': 'amelia.ebda.app',
        'x-forwarded-host': 'amelia.ebda.app',
      })
    );
    expect(new URL(rewriteOf(res)).pathname).toBe(
      '/tenant-store/demo-boutique.ebda.app/en/products'
    );
    expect(forwarded(res, 'x-store-domain')).toBe('demo-boutique.ebda.app');
    expect(forwarded(res, 'x-store-slug')).toBeNull();
  });

  it('header-based (non-tree) routes carry the request host as the store, per request', () => {
    process.env.STOREFRONT_TENANT_ROUTING = 'false';
    const a = middleware(at('amelia.ebda.app', '/cart'));
    const b = middleware(at('demo-boutique.ebda.app', '/cart'));
    expect(forwarded(a, 'x-store-domain')).toBe('amelia.ebda.app');
    expect(forwarded(b, 'x-store-domain')).toBe('demo-boutique.ebda.app');
  });

  it('a dev-only suffix is canonicalised to the real store host (outside production)', () => {
    process.env.NODE_ENV = 'development';
    const res = middleware(at('amelia.localhost:3000', '/products'));
    expect(forwarded(res, 'x-store-domain')).toBe('amelia.ebda.app');
  });

  it.each(['ebda.app', 'www.ebda.app'])('the apex %s never resolves a store', host => {
    const res = middleware(
      at(host, '/demo-boutique/products', { cookie: 'x-store-slug=demo-boutique' })
    );
    // `www.ebda.app` canonicalises to the apex (301); the apex itself passes through.
    expect([200, 301]).toContain(res.status);
    expect(forwarded(res, 'x-store-domain')).toBeNull();
    expect(forwarded(res, 'x-store-slug')).toBeNull();
    expect(rewriteOf(res)).not.toContain('/tenant-store/');
    expect(res.headers.get('set-cookie') ?? '').not.toContain('x-store-slug');
  });

  it.each(['admin.ebda.app', 'api.ebda.app', 'orders.ebda.app', 'docs.ebda.app'])(
    'platform service host %s is not served by the storefront (404, no store)',
    host => {
      const res = middleware(at(host, '/'));
      expect(res.status).toBe(404);
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(forwarded(res, 'x-store-domain')).toBeNull();
    }
  );

  // Upcoming products: Ebda AI Studio's coming-soon page (200 + noindex), still no store and nothing cacheable.
  it.each([
    'crm.ebda.app',
    'erp.ebda.app',
    'invite.ebda.app',
    'ads.ebda.app',
    'quote.ebda.app',
    'quote-studio.ebda.app',
    'hub.ebda.app',
    'id.ebda.app',
  ])('upcoming product host %s is a coming-soon page, never a store', host => {
    const res = middleware(at(host, '/'));
    expect(res.status).toBe(200);
    expect(res.headers.get('x-robots-tag')).toContain('noindex');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(forwarded(res, 'x-store-domain')).toBeNull();
  });

  // Ebda Chat is LIVE at wa.ebda.app (Ruling WHATSAPP-HOST-REDIRECT-1): whatsapp.ebda.app is a 301 there, path and
  // query kept, and never a "coming soon" page again.
  it.each([
    ['whatsapp.ebda.app', '/', 'https://wa.ebda.app/'],
    ['whatsapp.ebda.app', '/inbox?x=1', 'https://wa.ebda.app/inbox?x=1'],
    ['chat.ebda.app', '/', 'https://wa.ebda.app/'],
    ['chat.ebda.app', '/inbox?x=1', 'https://wa.ebda.app/inbox?x=1'],
  ])('%s%s redirects (301) to the live Ebda Chat at %s', (host, path, target) => {
    const res = middleware(at(host, path));
    expect(res.status).toBe(301);
    expect(res.headers.get('location')).toBe(target);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(forwarded(res, 'x-store-domain')).toBeNull();
  });

  // Not an open redirect: whatever the path, the 301 stays on wa.ebda.app (a `//host` path must never become the origin)
  it.each(['whatsapp.ebda.app', 'chat.ebda.app'])('%s: hostile paths stay on wa.ebda.app', host => {
    for (const path of [
      '//evil.com',
      '//evil.com/x',
      '/\\evil.com',
      '/%2F%2Fevil.com',
      '/..//evil.com',
      '///evil.com/x?y=1',
      '/inbox?x=1',
    ]) {
      const res = middleware(at(host, path));
      expect(res.status, path).toBe(301);
      const loc = new URL(res.headers.get('location')!);
      expect(loc.host, path).toBe('wa.ebda.app');
      expect(loc.protocol, path).toBe('https:');
    }
    expect(middleware(at(host, '/inbox?x=1')).headers.get('location')).toBe(
      'https://wa.ebda.app/inbox?x=1'
    );
  });

  it('redirectTarget never leaves the fixed host, even for raw (unparsed) hostile paths', () => {
    for (const p of [
      '//evil.com',
      '/\\evil.com',
      '\\\\evil.com',
      '/%2F%2Fevil.com',
      '/..//evil.com',
      '//',
      '',
      'evil.com',
    ]) {
      const loc = new URL(redirectTarget('wa.ebda.app', p, '?q=1'));
      expect(loc.host, p).toBe('wa.ebda.app');
      expect(loc.protocol, p).toBe('https:');
    }
    expect(redirectTarget('wa.ebda.app', '/inbox', '?x=1')).toBe('https://wa.ebda.app/inbox?x=1');
  });

  // SUBDOMAIN-SOON-2: every coming-soon software product has its page, named as in BRAND.comingProducts. invite/ads/quote
  // used to reach the store lookup (500s and the store's 404); now none of them ever looks up a store.
  it.each([
    ['crm.ebda.app', 'ابدأ CRM', 'Ebda CRM'],
    ['erp.ebda.app', 'ابدأ ERP', 'Ebda ERP'],
    ['invite.ebda.app', 'ابدأ إنفايت', 'Ebda Invite'],
    ['ads.ebda.app', 'ابدأ آدز', 'Ebda Ads'],
    ['quote.ebda.app', 'ابدأ ستوديو للتسعير', 'Ebda Quote Studio'],
  ])(
    '%s is its coming-soon page, Arabic by default and English on ?lang=en',
    async (host, ar, en) => {
      const resAr = middleware(at(host, '/'));
      expect(resAr.status).toBe(200);
      expect(forwarded(resAr, 'x-store-domain')).toBeNull();
      const tAr = await resAr.text();
      expect(tAr).toContain(`<h1>${ar}</h1>`);
      expect(tAr).toContain(`<title>${ar} جاي قريب.`);
      const tEn = await middleware(at(host, '/?lang=en')).text();
      expect(tEn).toContain(`<h1>${en}</h1>`);
      expect(tEn).toContain(`<title>${en} is coming soon.`);
    }
  );

  it('nothing the storefront renders says Ebda Chat is coming soon', async () => {
    const { renderStudioPage } = await import('@ebda/shared');
    for (const lang of ['ar', 'en'] as const)
      for (const kind of ['coming-soon', 'not-found'] as const) {
        const html = renderStudioPage({ lang, kind, product: 'crm' });
        expect(html).not.toMatch(/(Ebda Chat|ابدأ شات)[^<]*(<b>)?[^<]*(coming soon|قريب)/i);
        expect(html).toContain('href="https://wa.ebda.app/"');
      }
  });

  it.each([
    'store.ebda.app', // there is no store.ebda.app
    'wa.ebda.app', // served by the Ebda Chat Worker's own route; if it ever reaches this Worker, a 404, never "coming soon"
    'app.ebda.app', // retired label: never served, never a store
    'x.y.ebda.app',
    'ab.ebda.app',
    '127.0.0.1:3000',
    'localhost:3000',
    '[::1]:3000',
  ])('invalid host %j is a 404 with nothing cacheable', host => {
    const res = middleware(at(host, '/products'));
    expect(res.status).toBe(404);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(forwarded(res, 'x-store-domain')).toBeNull();
  });

  it('www custom domains still 301 to the apex; www.<store>.ebda.app is invalid', () => {
    expect(middleware(at('www.ameliaaurum.com', '/products?p=2')).status).toBe(301);
    expect(middleware(at('www.amelia.ebda.app', '/')).status).toBe(404);
  });

  it('there is no path-based store entry: /<slug>/… on a store host is just a path', () => {
    const res = middleware(at('demo-boutique.ebda.app', '/amelia/products'));
    expect(forwarded(res, 'x-store-domain')).toBe('demo-boutique.ebda.app');
    expect(rewriteOf(res)).not.toContain('amelia.ebda.app');
  });
});

// ─── 2. store-resolver ─────────────────────────────────────────────────────

interface FakeStore {
  id: string;
  slug: string;
  name: string;
}
const STORES: Record<string, FakeStore> = {
  'amelia.ebda.app': { id: 'store-a', slug: 'amelia', name: 'Amelia Aurum' },
  'ameliaaurum.com': { id: 'store-a', slug: 'amelia', name: 'Amelia Aurum' },
  'demo-boutique.ebda.app': { id: 'store-b', slug: 'demo-boutique', name: 'Demo Boutique' },
};

const fetchMock = vi.fn();

function installApi() {
  fetchMock.mockReset();
  // Behaves like the real API: the store is chosen by the `x-store-domain` header.
  fetchMock.mockImplementation(async (url: string, init?: { headers?: Record<string, string> }) => {
    if (String(url).includes('/public/store/resolve')) {
      const host = init?.headers?.['x-store-domain'] ?? '';
      const store = STORES[host];
      if (!store) {
        return {
          ok: false,
          status: 404,
          json: async () => ({ success: false, error: { code: 'STORE_NOT_FOUND' } }),
        };
      }
      return { ok: true, status: 200, json: async () => ({ success: true, data: { store } }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  });
  vi.stubGlobal('fetch', fetchMock);
}

describe('store-resolver — per-host store cache', () => {
  let resolver: typeof import('../../apps/web/src/lib/store-resolver');

  beforeEach(async () => {
    vi.resetModules();
    headerBag.value.clear();
    installApi();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    resolver = await import('../../apps/web/src/lib/store-resolver');
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const asHost = (host: string) => {
    headerBag.value.clear();
    headerBag.value.set('x-store-domain', host);
  };

  it('store A then store B at the same path: each gets its own store, before and after A is cached', async () => {
    asHost('amelia.ebda.app');
    const a1 = await resolver.getStoreOrNotFound(); // fills A's cache
    asHost('demo-boutique.ebda.app');
    const b1 = await resolver.getStoreOrNotFound();
    asHost('amelia.ebda.app');
    const a2 = await resolver.getStoreOrNotFound(); // served from A's cache
    asHost('demo-boutique.ebda.app');
    const b2 = await resolver.getStoreOrNotFound();
    asHost('ameliaaurum.com'); // A's custom domain
    const aCustom = await resolver.getStoreOrNotFound();

    expect([a1.id, b1.id, a2.id, b2.id, aCustom.id]).toEqual([
      'store-a',
      'store-b',
      'store-a',
      'store-b',
      'store-a',
    ]);
    // The in-process cache is real (3 hosts → 3 API calls, not 5)...
    expect(fetchMock).toHaveBeenCalledTimes(3);
    // ...and every API call named the HOST it was resolving.
    expect(fetchMock.mock.calls.map(c => c[1].headers['x-store-domain']).sort()).toEqual([
      'amelia.ebda.app',
      'ameliaaurum.com',
      'demo-boutique.ebda.app',
    ]);
  });

  it('an unknown host asked AFTER a known one is a 404 — no stale store, no default store', async () => {
    asHost('amelia.ebda.app');
    expect((await resolver.getStoreOrNotFound()).id).toBe('store-a'); // cached
    asHost('nobody.ebda.app');
    await expect(resolver.getStoreOrNotFound()).rejects.toBe(NOT_FOUND);
    asHost('nobody.example.com');
    await expect(resolver.getStoreOrNotFound()).rejects.toBe(NOT_FOUND);
    asHost('amelia.ebda.app'); // the known one is unaffected
    expect((await resolver.getStoreOrNotFound()).id).toBe('store-a');
  });

  it('a 404 is never cached as a store: a host that appears later resolves once the miss window ends', async () => {
    // Ruling RESOLVE-BULLETPROOF-1: a definitive miss IS remembered briefly (unknown hosts must not drain the API).
    // On Cloudflare a domain add bumps the host purge epoch and the miss is dropped at once
    // (store-resolve-bulletproof.test.ts "domain added"); here, without R2, it lasts LOCAL_MISS_TTL_MS.
    const { LOCAL_MISS_TTL_MS } = await import('../../apps/web/src/lib/store-resolve-cache');
    asHost('newshop.ebda.app');
    await expect(resolver.getStoreOrNotFound()).rejects.toBe(NOT_FOUND);
    STORES['newshop.ebda.app'] = { id: 'store-new', slug: 'newshop', name: 'New' };
    const t0 = Date.now();
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => t0 + LOCAL_MISS_TTL_MS + 1);
    try {
      expect((await resolver.getStoreOrNotFound()).id).toBe('store-new');
    } finally {
      clock.mockRestore();
      delete STORES['newshop.ebda.app'];
    }
  });

  it('a request with no store host (the apex / a platform host) never renders a store', async () => {
    headerBag.value.clear();
    await expect(resolver.getStoreOrNotFound()).rejects.toBe(NOT_FOUND);
    expect(fetchMock).not.toHaveBeenCalled();
    // The lenient chrome resolver hands back the neutral sentinel, never a real store.
    expect((await resolver.getStore()).id).toBe('demo');
  });

  it('the lenient chrome resolver never answers an unknown host with another store', async () => {
    asHost('amelia.ebda.app');
    await resolver.getStore(); // A cached
    asHost('nobody.ebda.app');
    const chrome = await resolver.getStore();
    expect(chrome.id).toBe('demo');
    expect(chrome.slug).not.toBe('amelia');
  });

  it('the tenant-tree resolver is keyed on the route host too (A, B, A, unknown)', async () => {
    const ids: string[] = [];
    for (const host of ['amelia.ebda.app', 'demo-boutique.ebda.app', 'amelia.ebda.app']) {
      ids.push((await resolver.getStoreByTenantParam(host)).id);
    }
    expect(ids).toEqual(['store-a', 'store-b', 'store-a']);
    await expect(resolver.getStoreByTenantParam('nobody.ebda.app')).rejects.toBe(NOT_FOUND);
    // Hand-built tenant keys that are not store hosts never resolve (and never reach the API).
    fetchMock.mockClear();
    for (const bad of ['slug:amelia', 'admin.ebda.app', 'ebda.app', '127.0.0.1']) {
      await expect(resolver.getStoreByTenantParam(bad)).rejects.toBe(NOT_FOUND);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('the resolve fetch bypasses the Next data cache and is keyed per host', async () => {
    asHost('demo-boutique.ebda.app');
    await resolver.getStoreOrNotFound();
    const [, init] = fetchMock.mock.calls[0];
    // Ruling RESOLVE-BULLETPROOF-1: OpenNext's tagCache is "dummy", so a tag purge never reached that cache.
    expect(init.cache).toBe('no-store');
    expect(init.next).toBeUndefined();
    expect(init.headers['x-store-domain']).toBe('demo-boutique.ebda.app');
  });
});
