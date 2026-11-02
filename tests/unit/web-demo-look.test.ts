/**
 * Demo showroom `?look=` preview (Phase S Task 9), web half.
 *
 *  1. middleware: a well-formed `?look=` is forwarded as `x-demo-look` and its response is
 *     `private, no-store` (and skips the shared tenant-tree rewrite); a client-sent
 *     `x-demo-look` is stripped; a malformed value forwards nothing.
 *  2. applyDemoLook (pure, `isBuilt` injectable): applied ONLY for `isDemo` + a built look.
 *  3. store-resolver end to end: the previewed look flows through the one composition path.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { composeStoreTheme, getLook } from '@ebda/shared';
import { middleware } from '../../apps/web/middleware';
import { applyDemoLook, parseDemoLook } from '../../apps/web/src/lib/demo-look';
import type { ResolvedStore } from '../../apps/web/src/lib/store-resolver';

const headerBag = vi.hoisted(() => ({ value: new Map<string, string>() }));
const builtOverride = vi.hoisted(() => ({ ids: new Set<string>() }));

vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
}));
vi.mock('next/headers', () => ({
  headers: async () => ({ get: (k: string) => headerBag.value.get(k.toLowerCase()) ?? null }),
}));
// Ruling R4: never flip real registry data; make a look 'built' for one test via the lookup seam.
vi.mock('@ebda/shared', async importOriginal => {
  const real = await importOriginal<typeof import('@ebda/shared')>();
  return {
    ...real,
    getLook: (id: string | null | undefined) => {
      const l = real.getLook(id);
      return l && builtOverride.ids.has(l.id) ? { ...l, status: 'built' as const } : l;
    },
  };
});

const forwarded = (res: Response, name: string) => res.headers.get(`x-middleware-request-${name}`);
const at = (host: string, path: string, headers: Record<string, string> = {}) =>
  new NextRequest(`https://${host}${path}`, { headers: { host, ...headers } });

describe('parseDemoLook', () => {
  it('accepts only the DB CHECK shape', () => {
    expect(parseDemoLook('qamar.atelier')).toBe('qamar.atelier');
    expect(parseDemoLook('dahab.giftbox')).toBe('dahab.giftbox');
    for (const bad of [
      '',
      'nope.atelier',
      'qamar.',
      'qamar.Atelier',
      'qamar.a1',
      'qamar.a b',
      '../x',
      null,
      undefined,
    ])
      expect(parseDemoLook(bad as string)).toBeNull();
  });
});

describe('middleware: ?look=', () => {
  it('rewrites a prefixed /ar|/en URL with ?look= (no 404) and keeps it private no-store', () => {
    vi.stubEnv('STOREFRONT_LOCALE_PATHS', 'true');
    vi.stubEnv('STOREFRONT_LOCALE_PATHS_STORES', 'all');
    try {
      for (const [path, rewritten] of [
        ['/ar?look=qamar.vitrine', '/'],
        ['/en/products?look=qamar.atelier', '/products'],
      ]) {
        const res = middleware(at('storedemo.ebda.app', path));
        expect(res.headers.get('x-middleware-rewrite')).toContain(`${rewritten}?look=`);
        expect(forwarded(res, 'x-demo-look')).toMatch(/^qamar\./);
        expect(res.headers.get('cache-control')).toBe('private, no-store');
      }
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('marks an old unprefixed /?look= link for the language redirect, query kept, no-store', () => {
    vi.stubEnv('STOREFRONT_LOCALE_PATHS', 'true');
    vi.stubEnv('STOREFRONT_LOCALE_PATHS_STORES', 'all');
    try {
      const res = middleware(at('storedemo.ebda.app', '/?look=qamar.vitrine'));
      expect(forwarded(res, 'x-locale-pending')).toBe('1');
      expect(forwarded(res, 'x-locale-search')).toBe('?look=qamar.vitrine');
      expect(res.headers.get('cache-control')).toBe('private, no-store');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('forwards a well-formed look as x-demo-look, private no-store', () => {
    const res = middleware(at('storedemo.ebda.app', '/products?look=qamar.atelier'));
    expect(forwarded(res, 'x-demo-look')).toBe('qamar.atelier');
    expect(res.headers.get('cache-control')).toBe('private, no-store');
  });

  it('takes the per-request path even when the shared tenant tree would apply', () => {
    vi.stubEnv('STOREFRONT_TENANT_ROUTING', 'true');
    vi.stubEnv('STOREFRONT_TENANT_ROUTING_ROUTES', 'all');
    vi.stubEnv('STOREFRONT_TENANT_ROUTING_STORES', 'storedemo');
    try {
      const plain = middleware(at('storedemo.ebda.app', '/products'));
      expect(plain.headers.get('x-middleware-rewrite')).toContain('/tenant-store/');
      const withLook = middleware(at('storedemo.ebda.app', '/products?look=souq.night'));
      expect(withLook.headers.get('x-middleware-rewrite')).toBeNull();
      expect(withLook.headers.get('cache-control')).toBe('private, no-store');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('strips a spoofed x-demo-look when there is no ?look=', () => {
    const res = middleware(
      at('storedemo.ebda.app', '/products', { 'x-demo-look': 'qamar.atelier' })
    );
    expect(forwarded(res, 'x-demo-look')).toBeNull();
  });

  it('replaces a spoofed header with the URL-derived value, never the client one', () => {
    const res = middleware(
      at('storedemo.ebda.app', '/?look=souq.night', { 'x-demo-look': 'qamar.atelier' })
    );
    expect(forwarded(res, 'x-demo-look')).toBe('souq.night');
  });

  it('a malformed look forwards nothing and does not force no-store', () => {
    const res = middleware(at('storedemo.ebda.app', '/?look=evil.<script>'));
    expect(forwarded(res, 'x-demo-look')).toBeNull();
    expect(res.headers.get('cache-control')).not.toBe('private, no-store');
  });

  it('a normal request has no demo header and no forced no-store', () => {
    const res = middleware(at('storedemo.ebda.app', '/'));
    expect(forwarded(res, 'x-demo-look')).toBeNull();
    expect(res.headers.get('cache-control')).not.toBe('private, no-store');
  });

  it('platform hosts (marketing) are untouched by ?look=', () => {
    const res = middleware(at('ebda.app', '/?look=qamar.atelier'));
    expect(forwarded(res, 'x-demo-look')).toBeNull();
    expect(res.headers.get('cache-control')).not.toBe('private, no-store');
  });
});

const baseStore = (over: Partial<ResolvedStore> = {}): ResolvedStore =>
  ({
    id: 's1',
    name: 'Demo',
    slug: 'storedemo',
    status: 'active',
    currency: 'EGP',
    timezone: 'Africa/Cairo',
    template: 'qamar',
    look: 'qamar.atelier',
    isDemo: true,
    theme: composeStoreTheme({ template: 'qamar', look: 'qamar.atelier', theme: {} }),
    socialLinks: {},
    ...over,
  }) as ResolvedStore;

describe('applyDemoLook', () => {
  const built = () => true;
  const designed = () => false;

  it('demo store + built look: template, look and theme come from the previewed look', () => {
    const out = applyDemoLook(baseStore(), 'souq.night', built);
    const look = getLook('souq.night')!;
    expect(out.look).toBe('souq.night');
    expect(out.template).toBe(look.skin);
    expect(out.theme).toEqual(
      composeStoreTheme({ template: look.skin, look: 'souq.night', theme: {} })
    );
  });

  it('keeps the showNewBadge merchant switch through the recomposition', () => {
    const on = baseStore({ theme: { showNewBadge: true } as ResolvedStore['theme'] });
    expect(applyDemoLook(on, 'qamar.lookbook', built).theme.showNewBadge).toBe(true);
    expect(applyDemoLook(baseStore(), 'qamar.lookbook', built).theme.showNewBadge).not.toBe(true);
  });

  it('demo store + designed look: ignored (same object)', () => {
    const s = baseStore();
    expect(applyDemoLook(s, 'souq.night', designed)).toBe(s);
  });

  it('NON-demo store: ignored even for a built look (same object, identical page)', () => {
    const s = baseStore({ isDemo: false });
    expect(applyDemoLook(s, 'souq.night', built)).toBe(s);
  });

  it('malformed / missing look: ignored', () => {
    const s = baseStore();
    expect(applyDemoLook(s, 'bad', built)).toBe(s);
    expect(applyDemoLook(s, null, built)).toBe(s);
  });

  it('a pattern-valid but unregistered look: ignored', () => {
    const s = baseStore();
    expect(applyDemoLook(s, 'qamar.doesnotexist', built)).toBe(s);
  });

  it('does not mutate the input store', () => {
    const s = baseStore();
    const snapshot = JSON.stringify(s);
    applyDemoLook(s, 'souq.night', built);
    expect(JSON.stringify(s)).toBe(snapshot);
  });
});

describe('store-resolver: x-demo-look', () => {
  const fetchMock = vi.fn();
  let resolver: typeof import('../../apps/web/src/lib/store-resolver');
  const apiStore = (isDemo: boolean) => ({
    ok: true,
    status: 200,
    json: async () => ({
      success: true,
      data: {
        store: {
          id: 'store-1',
          slug: 'storedemo',
          name: 'Demo',
          template: 'qamar',
          look: 'qamar.atelier',
          isDemo,
          theme: {},
        },
      },
    }),
  });

  beforeEach(async () => {
    vi.resetModules();
    builtOverride.ids.clear();
    headerBag.value.clear();
    headerBag.value.set('x-store-domain', 'storedemo.ebda.app');
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    resolver = await import('../../apps/web/src/lib/store-resolver');
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('demo + built look: the previewed look is applied; the cached base store is not changed', async () => {
    builtOverride.ids.add('souq.night');
    fetchMock.mockResolvedValue(apiStore(true));
    headerBag.value.set('x-demo-look', 'souq.night');
    const previewed = await resolver.getStoreOrNotFound();
    expect(previewed.look).toBe('souq.night');
    expect(previewed.template).toBe(getLook('souq.night')!.skin);

    // Same instance, next visitor with no param: the stored look, from the (cached) base store.
    headerBag.value.delete('x-demo-look');
    const plain = await resolver.getStoreOrNotFound();
    expect(plain.look).toBe('qamar.atelier');
    expect(plain.template).toBe('qamar');
  });

  it('demo + a look that is not built (every registry look is built since B5, so an unregistered id stands in): ignored', async () => {
    fetchMock.mockResolvedValue(apiStore(true));
    headerBag.value.set('x-demo-look', 'dahab.not-built-yet');
    expect((await resolver.getStoreOrNotFound()).look).toBe('qamar.atelier');
  });

  it('non-demo store: ?look= changes nothing', async () => {
    builtOverride.ids.add('souq.night');
    fetchMock.mockResolvedValue(apiStore(false));
    headerBag.value.set('x-demo-look', 'souq.night');
    const s = await resolver.getStoreOrNotFound();
    expect(s.look).toBe('qamar.atelier');
    expect(s.isDemo).toBe(false);
  });

  it('getStore({ demoPreview: false }) (the /og card) never applies the preview', async () => {
    builtOverride.ids.add('souq.night');
    fetchMock.mockResolvedValue(apiStore(true));
    headerBag.value.set('x-demo-look', 'souq.night');
    expect((await resolver.getStore({ demoPreview: false })).look).toBe('qamar.atelier');
  });

  it('the lenient getStore() applies it the same way', async () => {
    builtOverride.ids.add('souq.night');
    fetchMock.mockResolvedValue(apiStore(true));
    headerBag.value.set('x-demo-look', 'souq.night');
    expect((await resolver.getStore()).look).toBe('souq.night');
  });
});
