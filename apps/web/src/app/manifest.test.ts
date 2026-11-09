import { describe, it, expect, vi, afterEach } from 'vitest';

/**
 * Issue #1857 — the Arabic PWA manifest description fallback
 * (`تسوق في ${store.name}`) interpolated the ENGLISH store name under
 * `<html lang="ar">` even though `store.nameAr` was available. Locked down
 * here against the mutation of reverting to `store.name` unconditionally.
 *
 * `getStore` and `cookies()` are mocked so this exercises `manifest()`'s
 * own locale/name-selection logic in isolation, the same pattern
 * `tests/unit/sitemap-fanout.test.ts` uses for another `app/*.ts` special
 * file that calls `next/headers` directly.
 */

const storeRef: { current: Record<string, unknown> | null } = { current: null };
const cookieRef: { lang: string | undefined } = { lang: undefined };

vi.mock('../lib/store-resolver', () => ({
  getStore: async () => storeRef.current,
}));

vi.mock('next/headers', () => ({
  headers: async () => new Headers(),
  cookies: async () => ({
    get: (k: string) =>
      k === 'force-language' && cookieRef.lang ? { value: cookieRef.lang } : undefined,
  }),
}));

const { default: manifest } = await import('./manifest');

function makeStore(overrides: Record<string, unknown> = {}) {
  return {
    id: 'store-1',
    name: 'Demo Shop',
    nameAr: 'وادي الجوز',
    slug: 'demo-shop',
    domain: undefined,
    favicon: undefined,
    theme: {},
    settings: {},
    ...overrides,
  };
}

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  storeRef.current = null;
  cookieRef.lang = undefined;
  vi.clearAllMocks();
});

describe('manifest — localized store name in the description fallback (#1857)', () => {
  it('ar locale: description uses the Arabic store name, never the English one', async () => {
    storeRef.current = makeStore();
    cookieRef.lang = 'ar';
    // fetchStoreManifest short-circuits on a non-ok response → basic-manifest
    // branch; the store fixture has no description/descriptionAr, so
    // pickMetaDescription also falls through to this fallback string.
    global.fetch = vi.fn(async () => ({ ok: false })) as unknown as typeof fetch;

    const result = await manifest();

    expect(result.description).toContain('وادي الجوز');
    expect(result.description).not.toContain('Demo Shop');
  });

  it('en locale (same store data): description stays English', async () => {
    storeRef.current = makeStore();
    cookieRef.lang = 'en';
    global.fetch = vi.fn(async () => ({ ok: false })) as unknown as typeof fetch;

    const result = await manifest();

    expect(result.description).toContain('Demo Shop');
  });

  it('ar locale, no nameAr set: falls back to the English name rather than going blank', async () => {
    storeRef.current = makeStore({ nameAr: undefined });
    cookieRef.lang = 'ar';
    global.fetch = vi.fn(async () => ({ ok: false })) as unknown as typeof fetch;

    const result = await manifest();

    expect(result.description).toContain('Demo Shop');
  });
});

// #2195 — name/short_name localize too, not only the description.
describe('manifest — localized name/short_name (#2195)', () => {
  it('basic branch, ar: name and short_name are the Arabic store name', async () => {
    storeRef.current = makeStore();
    cookieRef.lang = 'ar';
    global.fetch = vi.fn(async () => ({ ok: false })) as unknown as typeof fetch;
    const result = await manifest();
    expect(result.name).toBe('وادي الجوز');
    expect(result.short_name).toBe('وادي الجوز');
  });

  it('basic branch, en: name stays English (control)', async () => {
    storeRef.current = makeStore();
    cookieRef.lang = 'en';
    global.fetch = vi.fn(async () => ({ ok: false })) as unknown as typeof fetch;
    expect((await manifest()).name).toBe('Demo Shop');
  });
});

// #2194 — the PWA-ENABLED branch (API manifest present) is the one merchants
// who configured an Arabic app name actually hit.
describe('manifest — API manifest branch picks the Arabic members under ar (#2194)', () => {
  const apiManifest = {
    name: 'Demo Shop App',
    short_name: 'Demo Shop',
    description: 'Shop at Demo Shop',
    name_ar: 'تطبيق وادي الجوز',
    short_name_ar: 'وادي',
    description_ar: 'تسوق من وادي الجوز',
  };
  const okFetch = (body: unknown) =>
    vi.fn(async () => ({ ok: true, json: async () => body })) as unknown as typeof fetch;

  it('ar: name / short_name / description come from the *_ar members', async () => {
    storeRef.current = makeStore();
    cookieRef.lang = 'ar';
    global.fetch = okFetch(apiManifest);
    const result = await manifest();
    expect(result.name).toBe('تطبيق وادي الجوز');
    expect(result.short_name).toBe('وادي');
    expect(result.description).toBe('تسوق من وادي الجوز');
  });

  it('en: the English members are used (control)', async () => {
    storeRef.current = makeStore();
    cookieRef.lang = 'en';
    global.fetch = okFetch(apiManifest);
    const result = await manifest();
    expect(result.name).toBe('Demo Shop App');
    expect(result.description).toBe('Shop at Demo Shop');
  });

  it('ar against an API that predates the *_ar members: never the English description', async () => {
    storeRef.current = makeStore();
    cookieRef.lang = 'ar';
    global.fetch = okFetch({ name: 'Demo Shop App', description: 'Shop at Demo Shop' });
    const result = await manifest();
    expect(result.description).toContain('وادي الجوز');
    expect(result.description).not.toContain('Shop at');
  });
});

// Pre-QA sweep 2026-11-09 (finding 6 class): the fetch went to `/public/<id>/manifest.json`, a path NO router serves. It
// answered 404 on every render, so the merchant's PWA manifest never applied, and each 404 on the public router was charged
// to the per-IP store-miss budget. The URL is checked against the API's generated route table, not against a string typed here.
describe('manifest — the per-store manifest is fetched from a route the API really serves', () => {
  it('GET <API>/stores/public/<storeId>/manifest.json, which is in the route table', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const routes = JSON.parse(
      readFileSync(resolve(__dirname, '../../../api/workers-test/route-table.json'), 'utf8')
    ) as string[];
    storeRef.current = makeStore();
    cookieRef.lang = 'en';
    const spy = vi.fn(async () => ({ ok: false }));
    global.fetch = spy as unknown as typeof fetch;

    await manifest();

    const url = String((spy.mock.calls[0] as unknown[])[0]);
    const apiPath = url.slice(url.indexOf('/api/v1') + '/api/v1'.length);
    expect(apiPath).toBe('/stores/public/store-1/manifest.json');
    const served = routes
      .filter(r => r.startsWith('GET '))
      .map(r => new RegExp(`^${r.slice(4).replace(/:[A-Za-z]+/g, '[^/]+')}$`));
    expect(served.some(re => re.test(apiPath))).toBe(true);
    // negative control: the old path is served by nothing
    expect(served.some(re => re.test('/public/store-1/manifest.json'))).toBe(false);
  });
});

// The per-store manifest is merchant input read over the network. Whatever goes wrong with it (the call fails, hangs, or
// answers something that fails `storePwaManifestSchema`), the storefront serves the generic manifest built from the
// store's own fields: a broken merchant manifest is never worse than no merchant manifest.
describe('manifest — a failed, slow or invalid per-store manifest falls back to the generic one', () => {
  const okFetch = (body: unknown) =>
    vi.fn(async () => ({ ok: true, json: async () => body })) as unknown as typeof fetch;
  const httpsIcon = {
    src: 'https://cdn.ebda.app/stores/store-1/icon-192.png',
    sizes: '192x192',
    type: 'image/png',
  };
  const authored = {
    name: 'Merchant App',
    short_name: 'Merchant',
    description: 'Shop at Merchant',
    theme_color: '#123456',
    background_color: '#ffffff',
    display: 'standalone',
    orientation: 'any',
    start_url: '/',
    scope: '/',
    icons: [httpsIcon, { ...httpsIcon, sizes: '512x512', purpose: 'maskable' }],
  };
  const genericIcons = [
    { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
    { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
  ];

  async function expectGeneric() {
    const result = await manifest();
    expect(result.name).toBe('Demo Shop');
    expect(result.short_name).toBe('Demo Shop');
    expect(result.start_url).toBe('/');
    expect(result.scope).toBeUndefined();
    expect(result.icons).toEqual(genericIcons);
    return result;
  }

  it('control: a valid authored manifest IS served, icons included', async () => {
    storeRef.current = makeStore();
    cookieRef.lang = 'en';
    global.fetch = okFetch(authored);
    const result = await manifest();
    expect(result.name).toBe('Merchant App');
    expect(result.theme_color).toBe('#123456');
    expect(result.start_url).toBe('/');
    expect(result.scope).toBe('/');
    expect(result.icons).toEqual([
      { ...httpsIcon, purpose: undefined },
      { ...httpsIcon, sizes: '512x512', purpose: 'maskable' },
    ]);
  });

  it('the API call rejects: generic manifest', async () => {
    storeRef.current = makeStore();
    cookieRef.lang = 'en';
    global.fetch = vi.fn(async () => {
      throw new Error('connect ECONNREFUSED');
    }) as unknown as typeof fetch;
    await expectGeneric();
  });

  it('the API call hangs: the timeout signal the fetch carries ends it, then generic manifest', async () => {
    storeRef.current = makeStore();
    cookieRef.lang = 'en';
    // The real timer is replaced by a signal this test fires, so the test does not wait out the real timeout.
    const timer = new AbortController();
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timer.signal);
    const spy = vi.fn(
      (_url: string, init: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          // a fetch that never answers on its own: only the signal it was given ends it
          init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        })
    );
    global.fetch = spy as unknown as typeof fetch;

    const pending = manifest();
    await vi.waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    timer.abort(new DOMException('The operation timed out.', 'TimeoutError'));
    const result = await pending;

    expect(timeout).toHaveBeenCalledWith(3000);
    expect(result.name).toBe('Demo Shop');
    expect(result.icons).toEqual(genericIcons);
    timeout.mockRestore();
  });

  it('the body is not JSON: generic manifest', async () => {
    storeRef.current = makeStore();
    cookieRef.lang = 'en';
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => {
        throw new SyntaxError('Unexpected token <');
      },
    })) as unknown as typeof fetch;
    await expectGeneric();
  });

  it.each([
    ['start_url on another origin', { start_url: 'https://evil.example/' }],
    ['protocol-relative start_url', { start_url: '//evil.example/' }],
    ['backslash start_url (read as //host by a browser)', { start_url: '/\\evil.example' }],
    ['start_url with a script scheme', { start_url: 'javascript:alert(1)' }],
    ['scope on another origin', { scope: 'https://evil.example/' }],
    [
      'a relative icon the storefront may not ship',
      { icons: [{ ...httpsIcon, src: '/icons/icon-192x192.png' }] },
    ],
    ['a plain-http icon', { icons: [{ ...httpsIcon, src: 'http://cdn.ebda.app/icon.png' }] }],
    ['a script-scheme icon', { icons: [{ ...httpsIcon, src: 'javascript:alert(1)' }] }],
    ['an icon that is not an image', { icons: [{ ...httpsIcon, type: 'text/html' }] }],
    ['a theme colour that is not a colour', { theme_color: 'url(https://evil.example)' }],
    ['a background colour that is not a colour', { background_color: 'red; background: url(x)' }],
    ['a display mode that does not exist', { display: 'kiosk' }],
    ['a name that is not a string', { name: { toString: 'x' } }],
    ['an answer that is not an object', null],
  ])('%s: the whole manifest is refused, generic manifest', async (_label, bad) => {
    storeRef.current = makeStore();
    cookieRef.lang = 'en';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    global.fetch = okFetch(bad === null ? 'not an object' : { ...authored, ...bad });
    await expectGeneric();
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  // What the API answers for a store whose merchant uploaded no icon (the dead `/icons/icon-192x192.png` defaults are
  // gone): the manifest is valid and the icons are the storefront's own.
  it('an API manifest with no icons: served, with the store favicon or the shipped icons', async () => {
    storeRef.current = makeStore();
    cookieRef.lang = 'en';
    global.fetch = okFetch({ ...authored, icons: [] });
    const result = await manifest();
    expect(result.name).toBe('Merchant App');
    expect(result.icons).toEqual(genericIcons);

    storeRef.current = makeStore({ favicon: 'https://cdn.ebda.app/stores/store-1/favicon.png' });
    global.fetch = okFetch({ ...authored, icons: [] });
    const withFavicon = await manifest();
    expect(withFavicon.icons?.map(icon => icon.src)).toEqual([
      'https://cdn.ebda.app/stores/store-1/favicon.png',
      'https://cdn.ebda.app/stores/store-1/favicon.png',
    ]);
  });
});
