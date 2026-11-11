/**
 * Web half of the inactive-store editor preview fix.
 *
 *  1. `middleware()` forwards `?_builder=` as `x-builder-preview-token` ONLY
 *     inside the `?_preview` iframe, strips any client-sent copy, and marks the
 *     canvas response `no-store` + `noindex`.
 *  2. `store-resolver` presents the token to the API on a cache-bypassing fetch
 *     and never reads/writes the per-instance store map for it; without a token
 *     the cached, tagged public fetch is unchanged. A miss is still `notFound()`.
 *
 * Token VALIDITY (signature/expiry/store binding) is the API's job and is
 * covered by builder-preview-inactive-store-resolve.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { middleware } from '../../apps/web/middleware';

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

const TOKEN = 'tok_A_abcdefghijklmnopqrstuv';
const forwarded = (res: Response, name: string) => res.headers.get(`x-middleware-request-${name}`);
const at = (host: string, path: string, headers: Record<string, string> = {}) =>
  new NextRequest(`https://${host}${path}`, { headers: { host, ...headers } });

describe('middleware — builder canvas token', () => {
  it('forwards _builder inside the _preview iframe, no-store + noindex', () => {
    const res = middleware(at('draftshop.ebda.app', `/?_preview=1&_builder=${TOKEN}`));
    expect(forwarded(res, 'x-builder-preview-token')).toBe(TOKEN);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(res.headers.get('x-robots-tag')).toContain('noindex');
  });

  it('does NOT forward _builder without _preview (public visit with a stray param)', () => {
    const res = middleware(at('draftshop.ebda.app', `/?_builder=${TOKEN}`));
    expect(forwarded(res, 'x-builder-preview-token')).toBeNull();
  });

  it('strips a client-sent x-builder-preview-token (cannot be spoofed outside the canvas)', () => {
    const res = middleware(
      at('draftshop.ebda.app', '/products', { 'x-builder-preview-token': TOKEN })
    );
    expect(forwarded(res, 'x-builder-preview-token')).toBeNull();
  });

  it('a normal public request gets no token header and no forced no-store', () => {
    const res = middleware(at('draftshop.ebda.app', '/'));
    expect(forwarded(res, 'x-builder-preview-token')).toBeNull();
    expect(res.headers.get('cache-control')).not.toBe('private, no-store');
  });
});

describe('store-resolver — token is presented, never cached', () => {
  const fetchMock = vi.fn();
  let resolver: typeof import('../../apps/web/src/lib/store-resolver');

  const ok = (id: string) => ({
    ok: true,
    status: 200,
    json: async () => ({
      success: true,
      data: { store: { id, slug: 'draftshop', name: 'Draft' } },
    }),
  });
  const miss = { ok: false, status: 404, json: async () => ({ success: false }) };

  beforeEach(async () => {
    vi.resetModules();
    headerBag.value.clear();
    headerBag.value.set('x-store-domain', 'draftshop.ebda.app');
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    resolver = await import('../../apps/web/src/lib/store-resolver');
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('inactive store + token: API is asked with the token on a no-store fetch -> renders', async () => {
    headerBag.value.set('x-builder-preview-token', TOKEN);
    fetchMock.mockResolvedValue(ok('store-draft'));
    const store = await resolver.getStoreOrNotFound();
    expect(store.id).toBe('store-draft');
    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers['x-builder-preview-token']).toBe(TOKEN);
    expect(init.cache).toBe('no-store');
    expect(init.next).toBeUndefined();
  });

  it('inactive store, no token: unchanged public fetch (no token, uncached by Next) and a miss is notFound()', async () => {
    fetchMock.mockResolvedValue(miss);
    await expect(resolver.getStoreOrNotFound()).rejects.toBe(NOT_FOUND);
    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers['x-builder-preview-token']).toBeUndefined();
    // Ruling RESOLVE-BULLETPROOF-1: resolve caching lives in store-resolve-cache.ts, not the Next data cache.
    expect(init.cache).toBe('no-store');
  });

  it('API rejects the token (other store / expired / forged) -> notFound()', async () => {
    headerBag.value.set('x-builder-preview-token', TOKEN);
    fetchMock.mockResolvedValue(miss);
    await expect(resolver.getStoreOrNotFound()).rejects.toBe(NOT_FOUND);
  });

  it('a malformed token header is ignored (treated as public)', async () => {
    headerBag.value.set('x-builder-preview-token', 'short');
    fetchMock.mockResolvedValue(miss);
    await expect(resolver.getStoreOrNotFound()).rejects.toBe(NOT_FOUND);
    expect(fetchMock.mock.calls[0][1].headers['x-builder-preview-token']).toBeUndefined();
  });

  it('a preview result is never written to the per-instance cache a public request reads', async () => {
    headerBag.value.set('x-builder-preview-token', TOKEN);
    fetchMock.mockResolvedValue(ok('store-draft'));
    await resolver.getStoreOrNotFound();
    // Same instance, now a PUBLIC request for the same host: must ask the API again (-> 404).
    headerBag.value.delete('x-builder-preview-token');
    fetchMock.mockResolvedValue(miss);
    await expect(resolver.getStoreOrNotFound()).rejects.toBe(NOT_FOUND);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('active store unaffected: public fetch is cached across calls', async () => {
    fetchMock.mockResolvedValue(ok('store-live'));
    await resolver.getStoreOrNotFound();
    await resolver.getStoreOrNotFound();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
