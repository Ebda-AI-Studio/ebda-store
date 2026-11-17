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

function stubResolve(
  answer: { ok: boolean; status?: number; isDemo?: boolean; storeStatus?: string } | 'throw'
) {
  const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
    if (answer === 'throw') throw new Error('network');
    expect(new URL(String(input)).pathname).toBe('/public/store/resolve');
    expect((init?.headers as Record<string, string>)['x-store-domain']).toBe(req.storeDomain);
    return {
      ok: answer.ok,
      status: answer.status ?? (answer.ok ? 200 : 404),
      json: async () => ({
        data: {
          store: { id: 's1', isDemo: answer.isDemo, status: answer.storeStatus ?? 'active' },
        },
      }),
    };
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const NORMAL = {
  rules: {
    userAgent: '*',
    allow: '/',
    disallow: ['/account/', '/checkout/', '/cart/', '/auth/', '/affiliate/'],
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

  it('an API error or a network failure keep the normal rules (a blip must not tell crawlers to leave)', async () => {
    for (const a of [{ ok: false, status: 503 }, { ok: false, status: 500 }, 'throw'] as const) {
      stubResolve(a);
      expect(await robots(), JSON.stringify(a)).toEqual({
        ...NORMAL,
        sitemap: 'https://shop.ebda.app/sitemap.xml',
      });
    }
  });

  // Ruling ROBOTS-CLOSED-1 (S3): qa-walk-store-1010.ebda.app is inactive, its storefront 404s, and robots.txt still said
  // "Allow: /" plus a Sitemap line.
  it('a host the resolver 404s (inactive, deleted, unknown) is Disallow: / with no sitemap', async () => {
    stubResolve({ ok: false, status: 404 });
    const r = await robots();
    expect(r).toEqual({ rules: [{ userAgent: '*', disallow: '/' }] });
    expect(r.sitemap).toBeUndefined();
  });

  it('a suspended store (served with its status for the maintenance page) is Disallow: / with no sitemap', async () => {
    stubResolve({ ok: true, storeStatus: 'suspended' });
    const r = await robots();
    expect(r).toEqual({ rules: [{ userAgent: '*', disallow: '/' }] });
    expect(r.sitemap).toBeUndefined();
  });

  it('a platform host (no x-store-domain) asks the API nothing', async () => {
    req.host = 'ebda.app';
    req.storeDomain = null;
    const fetchMock = stubResolve({ ok: true, isDemo: true });
    expect(await robots()).toEqual({ ...NORMAL, sitemap: 'https://ebda.app/sitemap.xml' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
