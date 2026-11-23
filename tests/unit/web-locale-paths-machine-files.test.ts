/**
 * LOCALE-PATHS-1: on a store with language-in-the-URL ON, `/llms.txt` and `/feeds/products.json` publish the CANONICAL
 * URLs (the store's default-language prefix), so an AI agent or a shopping feed never follows a link that redirects.
 * Off, both are byte-for-byte what they were. The default language is the store's own `settings.defaultLanguage`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decideLocalePath, localizeUrlsInText } from '../../apps/web/src/lib/locale-paths';

const headerBag = new Map<string, string>();
vi.mock('next/headers', () => ({
  headers: async () => ({ get: (k: string) => headerBag.get(k) ?? null }),
  cookies: async () => ({ get: () => undefined }),
}));

const KEYS = ['STOREFRONT_LOCALE_PATHS', 'STOREFRONT_LOCALE_PATHS_STORES'] as const;
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  headerBag.clear();
  for (const k of KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  vi.unstubAllGlobals();
  for (const k of KEYS)
    saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]);
});
const on = () => {
  process.env.STOREFRONT_LOCALE_PATHS = 'true';
  process.env.STOREFRONT_LOCALE_PATHS_STORES = 'p.example';
};

describe('localizeUrlsInText', () => {
  const o = 'https://p.example';
  const text = [
    `- Website: ${o}`,
    `- [Ring](${o}/products/gold-ring) — 50.00 EGP`,
    `- [Abayas](${o}/products?category=abayas)`,
    `- [Index](${o}/llms.txt) and ${o}/sitemap.xml and ${o}/feeds/products.json`,
    `- [Cart](${o}/cart)`,
    `- elsewhere https://p.example.evil/products and https://other.example/products`,
  ].join('\n');
  it('moves every indexable store URL to the prefix and nothing else', () => {
    const out = localizeUrlsInText(text, [o], 'ar');
    expect(out).toContain(`- Website: ${o}/ar\n`);
    expect(out).toContain(`(${o}/ar/products/gold-ring)`);
    expect(out).toContain(`(${o}/ar/products?category=abayas)`);
    expect(out).toContain(`(${o}/llms.txt) and ${o}/sitemap.xml and ${o}/feeds/products.json`);
    expect(out).toContain(`(${o}/ar/cart)`);
    expect(out).toContain('https://p.example.evil/products and https://other.example/products');
  });
  it('locale null is the identity; a second origin is localized too', () => {
    expect(localizeUrlsInText(text, [o], null)).toBe(text);
    expect(
      localizeUrlsInText('x https://s.ebda.app/about y', [o, 'https://s.ebda.app'], 'en')
    ).toBe('x https://s.ebda.app/en/about y');
  });
});

function storeJson(defaultLanguage: string) {
  return {
    id: 'store_1',
    name: 'Demo',
    slug: 'demo',
    domain: 'p.example',
    status: 'active',
    settings: { defaultLanguage },
  };
}

describe('GET /llms.txt on a locale-path store', () => {
  const stub = (defaultLanguage: string) =>
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const u = String(url);
        if (u.includes('/public/store/resolve') || u.includes('/public/stores/'))
          return new Response(
            JSON.stringify({ data: { store: storeJson(defaultLanguage), enabledFeatures: [] } })
          );
        if (u.includes('/public/categories'))
          return new Response(
            JSON.stringify({ data: { categories: [{ name: 'Abayas', slug: 'abayas' }] } })
          );
        if (u.includes('/public/products'))
          return new Response(
            JSON.stringify({
              data: { products: [{ name: 'Ring', slug: 'gold-ring', price: 5000 }] },
            })
          );
        return new Response('{}', { status: 404 });
      })
    );
  const get = async () => {
    headerBag.set('x-store-domain', 'p.example');
    const { GET } = await import('../../apps/web/src/app/llms.txt/route');
    const res = await GET();
    expect(res.status).toBe(200);
    return res.text();
  };

  it('off: URLs are unprefixed, exactly as before', async () => {
    stub('ar');
    const body = await get();
    expect(body).toContain('https://p.example/products/gold-ring');
    expect(body).not.toMatch(/https:\/\/p\.example\/(ar|en)\b/);
  });

  it('on: every product, category and home URL carries the store default language, and no unprefixed one is left', async () => {
    on();
    stub('ar');
    const body = await get();
    expect(body).toContain('https://p.example/ar/products/gold-ring');
    expect(body).toContain('https://p.example/ar/products?category=abayas');
    const links = [...body.matchAll(/https:\/\/p\.example(\/[^\s)]*)?/g)].map(m => m[1] ?? '/');
    const indexable = links.filter(
      p =>
        /^\/(products|categories|about|contact|faq|blog)?(\/|\?|$)/.test(p) &&
        !/^\/(ar|en)(\/|$)/.test(p) &&
        p !== '/llms.txt' &&
        p !== '/sitemap.xml'
    );
    expect(indexable).toEqual([]);
  });

  it('on: /en/llms.txt (x-locale-path=en) lists /en/ URLs even when the store default is ar', async () => {
    on();
    stub('ar');
    headerBag.set('x-locale-path', 'en');
    const body = await get();
    expect(body).toContain('https://p.example/en/products/gold-ring');
    expect(body).not.toContain('https://p.example/ar/');
  });

  it("on: the language is the store's own setting, so it follows a change with no env edit", async () => {
    on();
    stub('en');
    expect(await get()).toContain('https://p.example/en/products/gold-ring');
  });
});

describe('GET /feeds/products.json on a locale-path store', () => {
  const feed = {
    products: [
      {
        id: 'p1',
        link: 'https://p.example/products/gold-ring',
        image_link: 'https://media.ebda.app/r.webp',
      },
      { id: 'p2', link: 'https://demo.ebda.app/products/chain' },
    ],
    home: 'https://p.example',
  };
  const stub = (defaultLanguage: string) =>
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        String(url).includes('/public/store/resolve')
          ? new Response(JSON.stringify({ data: { store: storeJson(defaultLanguage) } }))
          : new Response(JSON.stringify(feed), { status: 200 })
      )
    );
  const get = async () => {
    headerBag.set('x-store-domain', 'p.example');
    const { GET } = await import('../../apps/web/src/app/feeds/products.json/route');
    return (await GET()).text();
  };

  it('off: forwarded byte for byte', async () => {
    stub('ar');
    expect(await get()).toBe(JSON.stringify(feed));
  });

  it('on: canonical prefixed product links on the host and on the slug origin; images untouched', async () => {
    on();
    stub('ar');
    const out = JSON.parse(await get());
    expect(out.products[0].link).toBe('https://p.example/ar/products/gold-ring');
    expect(out.products[1].link).toBe('https://demo.ebda.app/ar/products/chain');
    expect(out.products[0].image_link).toBe('https://media.ebda.app/r.webp');
    expect(out.home).toBe('https://p.example/ar');
  });

  it('on: /ar/feeds/products.json (x-locale-path=ar) wins over an English default', async () => {
    on();
    stub('en');
    headerBag.set('x-locale-path', 'ar');
    expect(JSON.parse(await get()).products[0].link).toBe(
      'https://p.example/ar/products/gold-ring'
    );
  });

  it('on: /en/feeds/products.json (x-locale-path=en) lists /en/ links under an ar default', async () => {
    on();
    stub('ar');
    headerBag.set('x-locale-path', 'en');
    expect(JSON.parse(await get()).products[0].link).toBe(
      'https://p.example/en/products/gold-ring'
    );
  });

  it('on: follows the store default language', async () => {
    on();
    stub('en');
    expect(JSON.parse(await get()).products[0].link).toBe(
      'https://p.example/en/products/gold-ring'
    );
  });
});

describe('the middleware decision for a prefixed machine file', () => {
  const d = (pathname: string) => decideLocalePath({ pathname, search: '', method: 'GET' });
  it.each([
    '/llms.txt',
    '/feeds/products.json',
    '/feeds/google.xml',
    '/feeds/meta.xml',
    '/feeds/tiktok.csv',
  ])(
    '/en%s and /ar%s are served in their language, not redirected to the unprefixed path',
    rest => {
      expect(d(`/en${rest}`)).toEqual({ kind: 'machine', locale: 'en', rest });
      expect(d(`/ar${rest}`)).toEqual({ kind: 'machine', locale: 'ar', rest });
    }
  );
  it('other prefixed non-routes still redirect, and the unprefixed file is untouched', () => {
    expect(d('/en/robots.txt')).toEqual({ kind: 'redirect', location: '/robots.txt' });
    expect(d('/llms.txt')).toEqual({ kind: 'none' });
    expect(d('/en/feeds/other.json')).toEqual({ kind: 'redirect', location: '/feeds/other.json' });
  });
});
