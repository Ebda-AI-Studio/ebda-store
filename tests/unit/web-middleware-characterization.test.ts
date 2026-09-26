import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { middleware } from '../../apps/web/middleware';

/**
 * CHARACTERIZATION tests for `apps/web/middleware.ts`.
 *
 * middleware() runs on EVERY storefront request for every live merchant, and the
 * code-health scan flags it at 39 branches / 247 lines. Before restructuring it,
 * these tests pin the behaviour that already exists — including the parts the
 * existing tenant-routing suite does not touch: the /tenant-store guard, the
 * www→apex canonical redirect, per-store favicon rewriting, preview-draft cookie
 * propagation, and the platform-domain slug/cookie fallbacks.
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
      req('https://wadyaljuz.com/tenant-store/x/en/products', 'wadyaljuz.com')
    );
    expect(res.status).toBe(404);
  });

  it('404s /tenant-store/* with the flag on', () => {
    process.env.STOREFRONT_TENANT_ROUTING = 'true';
    const res = middleware(
      req('https://wadyaljuz.com/tenant-store/x/en/products', 'wadyaljuz.com')
    );
    expect(res.status).toBe(404);
  });

  it('404s /tenant-store/* on a platform host too', () => {
    const res = middleware(req('https://store.force-ai.co/tenant-store/x/en', 'store.force-ai.co'));
    expect(res.status).toBe(404);
  });
});

describe('middleware — www→apex canonicalisation', () => {
  it('301s a www custom domain to its apex, preserving path and query', () => {
    const res = middleware(req('https://www.wadyaljuz.com/products?page=2', 'www.wadyaljuz.com'));
    expect(res.status).toBe(301);
    const loc = new URL(res.headers.get('location') as string);
    expect(loc.host).toBe('wadyaljuz.com');
    expect(loc.pathname).toBe('/products');
    expect(loc.search).toBe('?page=2');
  });

  it('does NOT redirect a www PLATFORM host', () => {
    // www.force-ai.co is a real platform host, not a merchant's www alias.
    const res = middleware(req('https://www.force-ai.co/', 'www.force-ai.co'));
    expect(res.status).not.toBe(301);
  });
});

describe('middleware — custom domain store binding', () => {
  it('binds the store via x-store-domain on the response', () => {
    const res = middleware(req('https://wadyaljuz.com/products', 'wadyaljuz.com'));
    expect(res.headers.get('x-store-domain')).toBe('wadyaljuz.com');
  });

  it('rewrites /favicon.ico to the per-store favicon route', () => {
    const res = middleware(req('https://wadyaljuz.com/favicon.ico', 'wadyaljuz.com'));
    expect(rewriteOf(res)).toContain('/api/store-favicon');
  });

  it('does NOT re-rewrite the favicon once the sf marker is present (loop guard)', () => {
    const res = middleware(req('https://wadyaljuz.com/favicon.ico?sf=1', 'wadyaljuz.com'));
    expect(rewriteOf(res) ?? '').not.toContain('/api/store-favicon');
  });

  it('leaves /favicon.ico alone on a platform host', () => {
    const res = middleware(req('https://store.force-ai.co/favicon.ico', 'store.force-ai.co'));
    expect(rewriteOf(res) ?? '').not.toContain('/api/store-favicon');
  });
});

describe('middleware — platform domain slug handling', () => {
  it('rewrites a slug-prefixed path and strips the slug', () => {
    const res = middleware(req('https://store.force-ai.co/palora/products', 'store.force-ai.co'));
    const rw = rewriteOf(res) as string;
    expect(rw).toBeTruthy();
    expect(new URL(rw).pathname).toBe('/products');
  });

  it('persists the slug cookie with a 30d maxAge, not as a session cookie', () => {
    // Without maxAge this dies on browser close, and a next-day deep-link on a
    // platform host has neither slug nor cookie — the CF-migration regression.
    const res = middleware(req('https://store.force-ai.co/palora/products', 'store.force-ai.co'));
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('x-store-slug=palora');
    expect(setCookie).toMatch(/Max-Age=2592000/i);
  });

  it('does not re-set the slug cookie when it already matches (keeps responses cacheable)', () => {
    const res = middleware(
      req('https://store.force-ai.co/palora/products', 'store.force-ai.co', {
        cookie: 'x-store-slug=palora',
      })
    );
    expect(res.headers.get('set-cookie') ?? '').not.toContain('x-store-slug=palora');
  });

  it('treats a known app route as an app route, not a store slug', () => {
    const res = middleware(req('https://store.force-ai.co/cart', 'store.force-ai.co'));
    const rw = rewriteOf(res);
    // /cart must not be mistaken for a store named "cart"
    if (rw) expect(new URL(rw).pathname).not.toBe('/');
  });

  it('clears a sticky slug cookie at the bare platform root', () => {
    const res = middleware(
      req('https://store.force-ai.co/', 'store.force-ai.co', { cookie: 'x-store-slug=palora' })
    );
    expect(res.headers.get('set-cookie') ?? '').toContain('x-store-slug=');
  });
});

describe('middleware — preview draft isolation', () => {
  // Unsaved admin edits must never leak to a real visitor who used the same
  // browser for previewing.
  it('sets the draft cookie inside the admin preview iframe', () => {
    const res = middleware(
      req('https://wadyaljuz.com/?_layoutDraft=tok123&_preview=9', 'wadyaljuz.com')
    );
    expect(res.headers.get('set-cookie') ?? '').toContain('force-preview-draft=tok123');
  });

  it('clears a stale draft cookie for a normal visitor (no _preview)', () => {
    const res = middleware(
      req('https://wadyaljuz.com/', 'wadyaljuz.com', { cookie: 'force-preview-draft=tok123' })
    );
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('force-preview-draft=');
    expect(setCookie).toMatch(/Max-Age=0/i);
  });

  it('does not set a draft cookie when _layoutDraft is present without _preview', () => {
    // A token in the URL alone is not proof of an admin iframe.
    const res = middleware(req('https://wadyaljuz.com/?_layoutDraft=tok123', 'wadyaljuz.com'));
    expect(res.headers.get('set-cookie') ?? '').not.toContain('force-preview-draft=tok123');
  });
});

describe('middleware — agent/feed documents never resolve the store from the sticky cookie (#1959)', () => {
  // These answer `public, s-maxage=…`; Cloudflare's cache key ignores Vary and
  // cookies, so a cookie-resolved store document cached under the bare
  // platform URL would be served to every other visitor. They resolve only
  // from the URL slug or the custom-domain Host.
  const forwardedSlug = (res: Response) => res.headers.get('x-middleware-request-x-store-slug');

  it.each([
    '/llms.txt',
    '/.well-known/acp.json',
    '/.well-known/ucp',
    '/.well-known/ucp/profile',
    '/feeds/products.json',
  ])('platform-host %s with an x-store-slug cookie carries NO store context', p => {
    const res = middleware(
      req(`https://store.force-ai.co${p}`, 'store.force-ai.co', { cookie: 'x-store-slug=palora' })
    );
    expect(forwardedSlug(res)).toBeNull();
    expect(rewriteOf(res)).toBeNull();
  });

  it('a normal subroute still carries the sticky store (control)', () => {
    const res = middleware(
      req('https://store.force-ai.co/products', 'store.force-ai.co', {
        cookie: 'x-store-slug=palora',
      })
    );
    expect(forwardedSlug(res)).toBe('palora');
  });

  it('the URL-slug form still resolves the store (/<slug>/llms.txt)', () => {
    const res = middleware(req('https://store.force-ai.co/palora/llms.txt', 'store.force-ai.co'));
    expect(forwardedSlug(res)).toBe('palora');
  });
});
