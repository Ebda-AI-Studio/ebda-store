/**
 * #2174 — the REAL request path for the agent-discovery documents.
 *
 * The routes' `viaCookie → private` branches are tested elsewhere by injecting
 * `x-store-slug-source: cookie` straight into a mocked `headers()`, which
 * proves nothing about production: what keeps a cookie (or path) from ever
 * resolving a store on these paths is that middleware.ts identifies a store by
 * the Host ALONE (`x-store-domain`) — the sticky `x-store-slug` cookie and the
 * `/<slug>` path entry are gone. This suite drives `middleware()` itself, then
 * hands the route exactly the request headers the middleware forwarded — so
 * reintroducing a cookie/path store identity turns it red.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { middleware } from '../../apps/web/middleware';

const forwarded = new Map<string, string>();
vi.mock('next/headers', () => ({
  headers: async () => ({ get: (k: string) => forwarded.get(k.toLowerCase()) ?? null }),
}));

/** Copy the request headers middleware forwarded (x-middleware-request-*). */
function captureForwarded(res: Response) {
  forwarded.clear();
  const prefix = 'x-middleware-request-';
  res.headers.forEach((value, key) => {
    if (key.startsWith(prefix)) forwarded.set(key.slice(prefix.length), value);
  });
}

function platformRequest(path: string) {
  return new NextRequest(`https://ebda.app${path}`, {
    headers: {
      host: 'ebda.app',
      cookie: 'x-store-slug=palora',
      // A client cannot forge the signal either.
      'x-store-slug-source': 'cookie',
    },
  });
}

function stubApi() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes('/public/store/resolve')) {
        return new Response(
          JSON.stringify({
            data: {
              store: { id: 'store_p', slug: 'palora', name: 'Palora', status: 'active' },
              enabledFeatures: ['agent_checkout', 'agent_feed'],
            },
          })
        );
      }
      if (u.includes('/public/stores/palora')) {
        return new Response(
          JSON.stringify({
            data: {
              store: { id: 'store_p', slug: 'palora', name: 'Palora', status: 'active' },
              enabledFeatures: ['agent_checkout', 'agent_feed'],
            },
          })
        );
      }
      if (u.includes('/public/categories')) {
        return new Response(JSON.stringify({ data: { categories: [] } }));
      }
      if (u.includes('/public/products')) {
        return new Response(
          JSON.stringify({ data: { products: [], pagination: { totalPages: 1 } } })
        );
      }
      if (u.includes('/public/stores?')) {
        return new Response(JSON.stringify({ data: [], pagination: { totalPages: 1 } }));
      }
      return new Response('{}', { status: 404 });
    })
  );
}

describe('agent-discovery documents on the real middleware path (#2174)', () => {
  beforeEach(() => {
    delete process.env.STOREFRONT_TENANT_ROUTING;
    stubApi();
  });
  afterEach(() => vi.unstubAllGlobals());

  it.each(['/llms.txt', '/.well-known/acp.json', '/.well-known/ucp', '/feeds/products.json'])(
    'platform-host %s with a sticky cookie forwards no store context and no cookie signal',
    path => {
      captureForwarded(middleware(platformRequest(path)));
      expect(forwarded.get('x-store-slug')).toBeUndefined();
      expect(forwarded.get('x-store-slug-source')).toBeUndefined();
      expect(forwarded.get('x-store-domain')).toBeUndefined();
    }
  );

  it('/llms.txt answers as the PLATFORM (shared-cacheable), never as the cookie store', async () => {
    captureForwarded(middleware(platformRequest('/llms.txt')));
    const { GET } = await import('../../apps/web/src/app/llms.txt/route');
    const res = await GET();
    const body = await res.text();
    expect(body).not.toContain('Palora');
    expect(body).toContain('# Ebda');
    expect(res.headers.get('cache-control')).toMatch(/^public, s-maxage=/);
  });

  it('/.well-known/acp.json answers 404 (the platform is not a shop), never the cookie store', async () => {
    captureForwarded(middleware(platformRequest('/.well-known/acp.json')));
    const { GET } = await import('../../apps/web/src/app/.well-known/acp.json/route');
    const res = await GET();
    expect(res.status).toBe(404);
  });

  it('a normal platform subroute does not carry the cookie store either', () => {
    captureForwarded(middleware(platformRequest('/products')));
    expect(forwarded.get('x-store-slug')).toBeUndefined();
    expect(forwarded.get('x-store-domain')).toBeUndefined();
  });

  it('control: <slug>.ebda.app/llms.txt DOES answer as that store, from the Host', async () => {
    captureForwarded(
      middleware(
        new NextRequest('https://palora.ebda.app/llms.txt', {
          headers: { host: 'palora.ebda.app' },
        })
      )
    );
    expect(forwarded.get('x-store-domain')).toBe('palora.ebda.app');
    const { GET } = await import('../../apps/web/src/app/llms.txt/route');
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Palora');
  });
});
