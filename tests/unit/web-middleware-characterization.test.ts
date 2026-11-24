import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { middleware, config } from '../../apps/web/middleware';

/**
 * CHARACTERIZATION tests for `apps/web/middleware.ts`.
 *
 * middleware() runs on EVERY storefront request for every live merchant, and the
 * code-health scan flags it at 39 branches / 247 lines. Before restructuring it,
 * these tests pin the behaviour that already exists — including the parts the
 * existing tenant-routing suite does not touch: the /tenant-store guard, the
 * www→apex canonical redirect, per-store favicon rewriting, preview-draft cookie
 * propagation, and (formerly) the platform-domain slug/cookie fallbacks, which
 * no longer exist: the Host alone identifies a store.
 *
 * They are deliberately written against OBSERVABLE OUTPUT (status, location,
 * x-middleware-rewrite, request/response headers, cookies) rather than internals,
 * so they stay valid across any refactor that preserves behaviour. If one of these
 * fails after a refactor, the refactor changed what merchants see.
 */

const ORIGINAL_ENV = process.env.STOREFRONT_TENANT_ROUTING;

beforeEach(() => {
  delete process.env.STOREFRONT_TENANT_ROUTING;
});

afterEach(() => {
  if (ORIGINAL_ENV === undefined) delete process.env.STOREFRONT_TENANT_ROUTING;
  else process.env.STOREFRONT_TENANT_ROUTING = ORIGINAL_ENV;
});

function req(url: string, host: string, headers: Record<string, string> = {}) {
  return new NextRequest(url, { headers: { host, ...headers } });
}

const rewriteOf = (res: Response) => res.headers.get('x-middleware-rewrite');

describe('middleware — internal rewrite target is not externally addressable', () => {
  // A direct external hit on /tenant-store/* would let ANY domain render ANY
  // tenant's storefront: a cross-tenant boundary violation. It must 404 whether
  // the routing flag is on or off, because the route tree exists either way.
  it('404s /tenant-store/* with the flag off', () => {
    const res = middleware(
      req('https://demo-shop.example/tenant-store/x/en/products', 'demo-shop.example')
    );
    expect(res.status).toBe(404);
  });

  it('404s /tenant-store/* with the flag on', () => {
    process.env.STOREFRONT_TENANT_ROUTING = 'true';
    const res = middleware(
      req('https://demo-shop.example/tenant-store/x/en/products', 'demo-shop.example')
    );
    expect(res.status).toBe(404);
  });

  it('404s /tenant-store/* on a platform host too', () => {
    const res = middleware(req('https://ebda.app/tenant-store/x/en', 'ebda.app'));
    expect(res.status).toBe(404);
  });
});

describe('middleware — www→apex canonicalisation', () => {
  it('301s a www custom domain to its apex, preserving path and query', () => {
    const res = middleware(
      req('https://www.demo-shop.example/products?page=2', 'www.demo-shop.example')
    );
    expect(res.status).toBe(301);
    const loc = new URL(res.headers.get('location') as string);
    expect(loc.host).toBe('demo-shop.example');
    expect(loc.pathname).toBe('/products');
    expect(loc.search).toBe('?page=2');
  });

  it('does NOT redirect a www PLATFORM host', () => {
    // ebda.app is a real platform host, not a merchant's www alias.
    const res = middleware(req('https://ebda.app/', 'ebda.app'));
    expect(res.status).not.toBe(301);
  });
});

describe('middleware — custom domain store binding', () => {
  it('binds the store via x-store-domain on the response', () => {
    const res = middleware(req('https://demo-shop.example/products', 'demo-shop.example'));
    expect(res.headers.get('x-store-domain')).toBe('demo-shop.example');
  });

  it('rewrites /favicon.ico to the per-store favicon route', () => {
    const res = middleware(req('https://demo-shop.example/favicon.ico', 'demo-shop.example'));
    expect(rewriteOf(res)).toContain('/api/store-favicon');
  });

  it('does NOT re-rewrite the favicon once the sf marker is present (loop guard)', () => {
    const res = middleware(req('https://demo-shop.example/favicon.ico?sf=1', 'demo-shop.example'));
    expect(rewriteOf(res) ?? '').not.toContain('/api/store-favicon');
  });

  it('leaves /favicon.ico alone on a platform host', () => {
    const res = middleware(req('https://ebda.app/favicon.ico', 'ebda.app'));
    expect(rewriteOf(res) ?? '').not.toContain('/api/store-favicon');
  });
});

describe('middleware — a platform host never resolves a store (no path, no cookie)', () => {
  const ctx = (res: Response, name: string) => res.headers.get(`x-middleware-request-${name}`);

  it('does NOT treat the first path segment as a store slug (no rewrite, no store context)', () => {
    const res = middleware(req('https://ebda.app/demo-boutique/products', 'ebda.app'));
    expect(rewriteOf(res)).toBeNull();
    expect(ctx(res, 'x-store-domain')).toBeNull();
    expect(ctx(res, 'x-store-slug')).toBeNull();
    expect(ctx(res, 'x-is-platform')).toBe('true');
  });

  it('does NOT set a sticky store cookie', () => {
    const res = middleware(req('https://ebda.app/demo-boutique/products', 'ebda.app'));
    expect(res.headers.get('set-cookie') ?? '').not.toContain('x-store-slug');
  });

  it('ignores a legacy x-store-slug cookie: it neither names a store nor is forwarded', () => {
    const res = middleware(
      req('https://ebda.app/products', 'ebda.app', { cookie: 'x-store-slug=demo-boutique' })
    );
    expect(ctx(res, 'x-store-slug')).toBeNull();
    expect(ctx(res, 'x-store-domain')).toBeNull();
    expect(rewriteOf(res)).toBeNull();
  });
});

describe('middleware — preview draft isolation', () => {
  // Unsaved admin edits must never leak to a real visitor who used the same
  // browser for previewing.
  it('sets the draft cookie inside the admin preview iframe', () => {
    const res = middleware(
      req('https://demo-shop.example/?_layoutDraft=tok123&_preview=9', 'demo-shop.example')
    );
    expect(res.headers.get('set-cookie') ?? '').toContain('force-preview-draft=tok123');
  });

  it('clears a stale draft cookie for a normal visitor (no _preview)', () => {
    const res = middleware(
      req('https://demo-shop.example/', 'demo-shop.example', {
        cookie: 'force-preview-draft=tok123',
      })
    );
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('force-preview-draft=');
    expect(setCookie).toMatch(/Max-Age=0/i);
  });

  it('does not set a draft cookie when _layoutDraft is present without _preview', () => {
    // A token in the URL alone is not proof of an admin iframe.
    const res = middleware(
      req('https://demo-shop.example/?_layoutDraft=tok123', 'demo-shop.example')
    );
    expect(res.headers.get('set-cookie') ?? '').not.toContain('force-preview-draft=tok123');
  });
});

describe('middleware — agent/feed documents resolve the store from the Host alone (#1959)', () => {
  // These answer `public, s-maxage=…`; Cloudflare's cache key ignores Vary and
  // cookies, so the store must come from the URL's HOST — never a cookie or path.
  const forwardedDomain = (res: Response) => res.headers.get('x-middleware-request-x-store-domain');

  it.each([
    '/llms.txt',
    '/.well-known/acp.json',
    '/.well-known/ucp',
    '/.well-known/ucp/profile',
    '/feeds/products.json',
  ])('apex %s with a legacy x-store-slug cookie carries NO store context', p => {
    const res = middleware(
      req(`https://ebda.app${p}`, 'ebda.app', { cookie: 'x-store-slug=demo-boutique' })
    );
    expect(forwardedDomain(res)).toBeNull();
    expect(res.headers.get('x-middleware-request-x-store-slug')).toBeNull();
    expect(rewriteOf(res)).toBeNull();
  });

  it.each(['/llms.txt', '/.well-known/acp.json', '/feeds/products.json'])(
    '<slug>.ebda.app%s carries that host as the store',
    p => {
      const res = middleware(req(`https://demo-boutique.ebda.app${p}`, 'demo-boutique.ebda.app'));
      expect(forwardedDomain(res)).toBe('demo-boutique.ebda.app');
    }
  );

  it('a store host ignores a cookie naming another store', () => {
    const res = middleware(
      req('https://demo-boutique.ebda.app/products', 'demo-boutique.ebda.app', {
        cookie: 'x-store-slug=demo-store',
      })
    );
    expect(forwardedDomain(res)).toBe('demo-boutique.ebda.app');
    expect(res.headers.get('x-middleware-request-x-store-slug')).toBeNull();
  });
});

describe('middleware — client-supplied store-context headers never reach the render (#2153)', () => {
  // requestHeaders is seeded from the RAW request. Every header in this list is
  // the middleware's own assertion; a client value must be dropped, and only
  // the value the middleware derives from Host / URL may survive.
  const forwarded = (res: Response, name: string) =>
    res.headers.get(`x-middleware-request-${name}`);

  const SPOOF = {
    'x-is-platform': 'true',
    'x-store-slug': 'evil',
    'x-store-slug-source': 'cookie',
    'x-store-domain': 'evil.example',
    'x-store-identifier': 'evil.example',
    'x-preview-draft': 'forged-draft',
    'x-original-host': 'evil.example',
  };

  it('custom domain: a spoofed x-is-platform / slug / draft is stripped', () => {
    const res = middleware(req('https://demo-shop.example/products', 'demo-shop.example', SPOOF));
    // Re-asserted as 'false' (never absent) so layout.tsx can tell a custom
    // domain apart from "middleware did not run" (#2091).
    expect(forwarded(res, 'x-is-platform')).toBe('false');
    expect(forwarded(res, 'x-store-slug')).toBeNull();
    expect(forwarded(res, 'x-store-slug-source')).toBeNull();
    expect(forwarded(res, 'x-preview-draft')).toBeNull();
    // The authentic values are re-asserted from the Host.
    expect(forwarded(res, 'x-store-domain')).toBe('demo-shop.example');
    expect(forwarded(res, 'x-store-identifier')).toBe('demo-shop.example');
    expect(forwarded(res, 'x-original-host')).toBe('demo-shop.example');
  });

  it('platform host: a spoofed x-store-domain cannot make /llms.txt answer as another store', () => {
    const res = middleware(req('https://ebda.app/llms.txt', 'ebda.app', SPOOF));
    expect(forwarded(res, 'x-store-domain')).toBeNull();
    expect(forwarded(res, 'x-store-identifier')).toBeNull();
    expect(forwarded(res, 'x-store-slug')).toBeNull();
    expect(forwarded(res, 'x-preview-draft')).toBeNull();
    expect(forwarded(res, 'x-is-platform')).toBe('true');
  });

  it('a draft header outside the preview iframe is dropped, inside it is re-derived', () => {
    const outside = middleware(
      req('https://demo-shop.example/', 'demo-shop.example', { 'x-preview-draft': 'forged' })
    );
    expect(forwarded(outside, 'x-preview-draft')).toBeNull();
    const inside = middleware(
      req('https://demo-shop.example/?_preview=1&_layoutDraft=real', 'demo-shop.example', {
        'x-preview-draft': 'forged',
      })
    );
    expect(forwarded(inside, 'x-preview-draft')).toBe('real');
  });
});

describe('middleware — /manifest.webmanifest gets the same store context as a page', () => {
  // Excluded from the matcher until 2026-10-01, so app/manifest.ts resolved no
  // store and every custom domain served the platform "Force" manifest.
  const matcher = new RegExp(`^${config.matcher[0]}$`);

  it('the matcher runs middleware on /manifest.webmanifest', () => {
    expect(matcher.test('/manifest.webmanifest')).toBe(true);
  });

  it('still skips the static files it exists to skip (control)', () => {
    // /sw.js is per store now (PW1): it needs the same store context the manifest does
    expect(matcher.test('/sw.js')).toBe(true);
    expect(matcher.test('/_next/static/chunks/a.js')).toBe(false);
    expect(matcher.test('/.well-known/security.txt')).toBe(false);
    expect(matcher.test('/api/store-favicon')).toBe(false);
  });

  it('custom domain: the manifest request carries x-store-domain', () => {
    const res = middleware(
      req('https://demo-store.example/manifest.webmanifest', 'demo-store.example')
    );
    expect(res.headers.get('x-middleware-request-x-store-domain')).toBe('demo-store.example');
    expect(rewriteOf(res)).toBeNull();
  });

  it('platform host: the manifest carries no store context, even with a legacy cookie', () => {
    const res = middleware(
      req('https://ebda.app/manifest.webmanifest', 'ebda.app', {
        cookie: 'x-store-slug=demo-boutique',
      })
    );
    expect(rewriteOf(res)).toBeNull();
    expect(res.headers.get('x-middleware-request-x-store-slug')).toBeNull();
    expect(res.headers.get('x-middleware-request-x-store-domain')).toBeNull();
  });

  it('<slug>.ebda.app: the manifest request carries the host as the store', () => {
    const res = middleware(
      req('https://demo-boutique.ebda.app/manifest.webmanifest', 'demo-boutique.ebda.app')
    );
    expect(res.headers.get('x-middleware-request-x-store-domain')).toBe('demo-boutique.ebda.app');
  });
});
