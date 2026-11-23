/**
 * Storefront robots.txt (Ruling B1-14, plan amendment C14): the demo showroom host stays crawlable
 * (its noindex meta is read) and advertises no sitemap; every other store host keeps today's rules. The store is
 * resolved through `/public/store/resolve` (its `isDemo`); a failure to ask keeps today's rules.
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
vi.mock('../../apps/web/src/lib/api', () => ({ API_URL: 'https://api.test' }));

import robots from '../../apps/web/src/app/robots';

function stubResolve(answer: { ok: boolean; status?: number; isDemo?: boolean } | 'throw') {
  const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
    if (answer === 'throw') throw new Error('network');
    expect(new URL(String(input)).pathname).toBe('/public/store/resolve');
    expect((init?.headers as Record<string, string>)['x-store-domain']).toBe(req.storeDomain);
    return {
      ok: answer.ok,
      status: answer.status ?? (answer.ok ? 200 : 404),
      json: async () => ({ data: { store: { id: 's1', isDemo: answer.isDemo } } }),
    };
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const NORMAL = {
  rules: {
    userAgent: '*',
    allow: '/',
    disallow: (() => {
      const roots = ['/account/', '/checkout/', '/cart/', '/auth/', '/affiliate/'];
      return [...roots, ...roots.map(p => `/ar${p}`), ...roots.map(p => `/en${p}`)];
    })(),
  },
};

describe('robots.txt and the demo showroom', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    req.host = 'shop.ebda.app';
    req.storeDomain = 'shop.ebda.app';
  });

  it('the demo host stays crawlable (its noindex meta must be readable) and lists no sitemap', async () => {
    req.host = req.storeDomain = 'storedemo.ebda.app';
    stubResolve({ ok: true, isDemo: true });
    const r = await robots();
    expect(r).toEqual({ rules: [NORMAL.rules] });
    expect(JSON.stringify(r.rules)).not.toContain('"disallow":"/"');
    expect(r.sitemap).toBeUndefined();
  });

  it('a merchant store keeps its rules and its own sitemap', async () => {
    stubResolve({ ok: true, isDemo: false });
    expect(await robots()).toEqual({ ...NORMAL, sitemap: 'https://shop.ebda.app/sitemap.xml' });
  });

  it('an unresolved host, an API error or a network failure keep the normal rules', async () => {
    for (const a of [{ ok: false, status: 404 }, { ok: false, status: 503 }, 'throw'] as const) {
      stubResolve(a);
      expect(await robots(), JSON.stringify(a)).toEqual({
        ...NORMAL,
        sitemap: 'https://shop.ebda.app/sitemap.xml',
      });
    }
  });

  it('a platform host (no x-store-domain) asks the API nothing', async () => {
    req.host = 'ebda.app';
    req.storeDomain = null;
    const fetchMock = stubResolve({ ok: true, isDemo: true });
    expect(await robots()).toEqual({ ...NORMAL, sitemap: 'https://ebda.app/sitemap.xml' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
