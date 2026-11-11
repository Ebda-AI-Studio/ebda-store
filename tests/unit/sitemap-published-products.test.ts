/**
 * A store with published products never gets a zero-URL sitemap, and robots names the sitemap
 * (ebda-foundation standard/storefront-sitemap-hreflang.md). Exception by design: a store whose merchant switched on
 * "hide from search engines" (or the demo showroom) lists nothing and advertises no sitemap.
 */
import { describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ hidden: false }));
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
}));
vi.mock('next/headers', () => ({
  headers: async () => ({
    get: (k: string) => (k === 'x-store-domain' || k === 'host' ? 'shop.example' : null),
  }),
}));
vi.mock('../../apps/web/src/lib/api', () => ({ API_URL: 'https://api.test' }));
vi.stubEnv('STOREFRONT_LOCALE_PATHS', 'true');
vi.stubEnv('STOREFRONT_LOCALE_PATHS_STORES', 'all');
vi.stubGlobal(
  'fetch',
  vi.fn(async (input: string | URL) => {
    const url = new URL(String(input));
    const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
    if (url.pathname.endsWith('/public/store/resolve'))
      return json({
        data: {
          store: {
            id: 's1',
            slug: 'shop',
            settings: { hideFromSearchEngines: state.hidden, defaultLanguage: 'ar' },
          },
        },
      });
    if (url.pathname.endsWith('/public/products'))
      return json({
        data: {
          products: [{ slug: 'ring', updatedAt: '2026-11-01T00:00:00Z' }, { slug: 'حلق' }],
          meta: { totalPages: 1 },
        },
      });
    return { ok: false, status: 403, json: async () => ({}) };
  })
);

import sitemap from '../../apps/web/src/app/sitemap';
import robots from '../../apps/web/src/app/robots';

describe('sitemap + robots', () => {
  it('lists home, products, static pages and every product for both locales, with hreflang and lastmod', async () => {
    state.hidden = false;
    const urls = await sitemap();
    expect(urls.length).toBeGreaterThan(0);
    const u = urls.map(e => e.url);
    for (const l of ['ar', 'en']) {
      expect(u).toContain(`https://shop.example/${l}`);
      expect(u).toContain(`https://shop.example/${l}/products`);
      expect(u).toContain(`https://shop.example/${l}/categories`);
      expect(u).toContain(`https://shop.example/${l}/products/ring`);
    }
    for (const e of urls) {
      expect(e.lastModified, e.url).toBeTruthy();
      expect(Object.keys(e.alternates?.languages ?? {}).sort(), e.url).toEqual([
        'ar',
        'en',
        'x-default',
      ]);
    }
  });
  it('robots names the sitemap on a listed store and disallows private routes under both prefixes', async () => {
    state.hidden = false;
    const r = await robots();
    expect(r.sitemap).toBe('https://shop.example/sitemap.xml');
    const rules = Array.isArray(r.rules) ? r.rules[0] : r.rules;
    expect(rules.disallow).toEqual(
      expect.arrayContaining(['/cart/', '/en/cart/', '/ar/checkout/'])
    );
  });
  it('a hidden store lists nothing and names no sitemap (the Amelia QA store case)', async () => {
    state.hidden = true;
    expect(await sitemap()).toEqual([]);
    expect((await robots()).sitemap).toBeUndefined();
  });
});
