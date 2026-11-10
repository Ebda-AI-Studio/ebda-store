import { describe, it, expect, vi, afterEach } from 'vitest';

/**
 * Issue #1857 — the Arabic PWA manifest description fallback
 * (`تسوق في ${store.name}`) interpolated the ENGLISH store name under
 * `<html lang="ar">` even though `store.nameAr` was available. Locked down
 * here against the mutation of reverting to `store.name` unconditionally.
 *
 * `getStore` and `cookies()` are mocked so this exercises the builder's
 * own locale/name-selection logic in isolation, the same pattern
 * `tests/unit/sitemap-fanout.test.ts` uses for an `app/*.ts` special
 * file that calls `next/headers` directly. The builder lived in
 * `app/manifest.ts` until Ruling PWA-MANIFEST-2 moved it here.
 */

const storeRef: { current: Record<string, unknown> | null } = { current: null };
const cookieRef: { lang: string | undefined } = { lang: undefined };
/** The language the middleware read from the URL (`/en/manifest.webmanifest` → `en`). */
const urlRef: { lang: string | undefined } = { lang: undefined };

vi.mock('../store-resolver', () => ({
  getStore: async () => storeRef.current,
}));

vi.mock('next/headers', () => ({
  headers: async () => new Headers(urlRef.lang ? { 'x-locale-path': urlRef.lang } : {}),
  cookies: async () => ({
    get: (k: string) =>
      k === 'force-language' && cookieRef.lang ? { value: cookieRef.lang } : undefined,
  }),
}));

const { buildStoreManifest: manifest } = await import('./store-manifest');

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
  urlRef.lang = undefined;
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
      readFileSync(resolve(__dirname, '../../../../api/workers-test/route-table.json'), 'utf8')
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

// Ruling PWA-MANIFEST-1 (the alternative, taken 2026-11-10). The API emits only the PWA settings the merchant SAVED; the
// storefront lays them over its generic manifest. So the per-store manifest applying for the first time changes nothing
// for a store that saved nothing, and a merchant who saved one field changes exactly that field.
describe('manifest — saved PWA settings are laid over the generic manifest (Ruling PWA-MANIFEST-1)', () => {
  const okFetch = (body: unknown) =>
    vi.fn(async () => ({ ok: true, json: async () => body })) as unknown as typeof fetch;
  const noApi = () => vi.fn(async () => ({ ok: false })) as unknown as typeof fetch;
  const shippedIcons = [
    { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
    { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
  ];
  const httpsIcon = {
    src: 'https://cdn.ebda.app/stores/store-1/icon-192.png',
    sizes: '192x192',
    type: 'image/png',
  };
  /** A store with its own description in both languages, a theme colour and a favicon. */
  const richStore = () =>
    makeStore({
      description: 'Handmade leather, made in Cairo',
      descriptionAr: 'جلد طبيعي صناعة يدوية في القاهرة',
      theme: { primaryColor: '210 50% 40%' },
      favicon: 'https://cdn.ebda.app/stores/store-1/favicon.png',
    });

  async function render(store: Record<string, unknown>, lang: string, fetchImpl: typeof fetch) {
    storeRef.current = store;
    cookieRef.lang = lang;
    global.fetch = fetchImpl;
    return manifest();
  }

  // What the generic branch answers today, typed out here and not read back from the code under test: a change to the
  // generic manifest itself has to change this.
  const genericToday = {
    ar: {
      name: 'وادي الجوز',
      short_name: 'وادي الجوز',
      description: 'تسوق في وادي الجوز',
      start_url: '/',
      display: 'standalone',
      background_color: '#ffffff',
      theme_color: '#B08D57',
      icons: shippedIcons,
    },
    en: {
      name: 'Demo Shop',
      short_name: 'Demo Shop',
      description: 'Shop at Demo Shop',
      start_url: '/',
      display: 'standalone',
      background_color: '#ffffff',
      theme_color: '#B08D57',
      icons: shippedIcons,
    },
  };

  describe('1. a store with NO saved settings (the API answers {}) keeps the generic manifest', () => {
    it.each(['ar', 'en'] as const)('%s: deep-equal to the generic manifest', async lang => {
      const withEmptyApi = await render(makeStore(), lang, okFetch({}));
      expect(withEmptyApi).toStrictEqual(genericToday[lang]);
      expect(withEmptyApi).not.toHaveProperty('scope');
      expect(withEmptyApi).not.toHaveProperty('orientation');
      // and it is the same object the no-API path answers
      expect(withEmptyApi).toStrictEqual(await render(makeStore(), lang, noApi()));
    });

    it.each(['ar', 'en'] as const)(
      '%s: a store with its own description, theme colour and favicon keeps all three',
      async lang => {
        const generic = await render(richStore(), lang, noApi());
        expect(generic.description).toBe(
          lang === 'ar' ? 'جلد طبيعي صناعة يدوية في القاهرة' : 'Handmade leather, made in Cairo'
        );
        expect(generic.theme_color).toBe('#336699');
        expect(generic.icons?.map(icon => icon.src)).toEqual([
          'https://cdn.ebda.app/stores/store-1/favicon.png',
          'https://cdn.ebda.app/stores/store-1/favicon.png',
        ]);
        expect(await render(richStore(), lang, okFetch({}))).toStrictEqual(generic);
      }
    );

    // The live demo store, as production serves it (measured 2026-11-10: no PWA settings saved, the template's own
    // primary colour, its own description in both languages). Its manifest must not move when the per-store manifest
    // starts applying.
    it.each([
      ['ar', 'قمر', 'بوتيك مصري توضيحي: عبايات وقفاطين وطرح وفساتين سهرة، متفصلة في مصر الجديدة.'],
      [
        'en',
        'Qamar',
        'An illustrative Egyptian boutique: abayas, kaftans, scarves and evening dresses, cut in Heliopolis.',
      ],
    ])(
      '%s: a store shaped like Qamar keeps its name, description and #141414',
      async (lang, name, description) => {
        const qamar = () =>
          makeStore({
            name: 'Qamar',
            nameAr: 'قمر',
            description:
              'An illustrative Egyptian boutique: abayas, kaftans, scarves and evening dresses, cut in Heliopolis.',
            descriptionAr:
              'بوتيك مصري توضيحي: عبايات وقفاطين وطرح وفساتين سهرة، متفصلة في مصر الجديدة.',
            theme: { primaryColor: '0 0% 8%', showNewBadge: true },
          });
        expect(await render(qamar(), lang, okFetch({}))).toStrictEqual({
          name,
          short_name: name,
          description,
          start_url: '/',
          display: 'standalone',
          background_color: '#ffffff',
          theme_color: '#141414',
          icons: shippedIcons,
        });
      }
    );

    it('blank strings from the API read as "not saved": still the generic manifest', async () => {
      const blank = {
        name: '',
        short_name: '  ',
        description: '',
        name_ar: ' ',
        description_ar: '',
      };
      for (const lang of ['ar', 'en'] as const) {
        expect(await render(makeStore(), lang, okFetch(blank))).toStrictEqual(genericToday[lang]);
      }
    });
  });

  describe('2. partly saved: the saved member wins, every other member is the generic value', () => {
    it.each([
      ['name', { name: 'Merchant App' }, { name: 'Merchant App' }],
      ['short_name', { short_name: 'Merchant' }, { short_name: 'Merchant' }],
      ['description', { description: 'Our own words' }, { description: 'Our own words' }],
      ['theme_color', { theme_color: '#123456' }, { theme_color: '#123456' }],
      ['background_color', { background_color: '#fefefe' }, { background_color: '#fefefe' }],
      ['display', { display: 'minimal-ui' }, { display: 'minimal-ui' }],
      ['orientation', { orientation: 'portrait' }, { orientation: 'portrait' }],
      ['start_url', { start_url: '/offers' }, { start_url: '/offers' }],
      ['scope', { scope: '/' }, { scope: '/' }],
      ['icons', { icons: [httpsIcon] }, { icons: [{ ...httpsIcon, purpose: undefined }] }],
      // the Arabic members are for the Arabic storefront only
      ['name_ar (ignored under en)', { name_ar: 'تطبيق التاجر' }, {}],
      ['description_ar (ignored under en)', { description_ar: 'كلامنا إحنا' }, {}],
    ])('en, only %s saved', async (_label, saved, expected) => {
      const generic = await render(richStore(), 'en', noApi());
      const result = await render(richStore(), 'en', okFetch(saved));
      expect(result).toStrictEqual({ ...generic, ...expected });
    });

    it.each([
      ['name_ar', { name_ar: 'تطبيق التاجر' }, { name: 'تطبيق التاجر' }],
      ['short_name_ar', { short_name_ar: 'التاجر' }, { short_name: 'التاجر' }],
      ['description_ar', { description_ar: 'كلامنا إحنا' }, { description: 'كلامنا إحنا' }],
      ['theme_color', { theme_color: '#123456' }, { theme_color: '#123456' }],
      // the store has an Arabic name: it beats a saved ENGLISH app name on the Arabic storefront
      ['name (English, store has an Arabic name)', { name: 'Merchant App' }, {}],
      ['short_name (English, store has an Arabic name)', { short_name: 'Merchant' }, {}],
      // a saved English description never shows under ar: the store's own Arabic description does
      ['description (English)', { description: 'Our own words' }, {}],
    ])('ar, only %s saved', async (_label, saved, expected) => {
      const generic = await render(richStore(), 'ar', noApi());
      const result = await render(richStore(), 'ar', okFetch(saved));
      expect(result).toStrictEqual({ ...generic, ...expected });
    });

    it('ar, a store with NO Arabic name: the saved English names are used, they are all there is', async () => {
      const store = () => makeStore({ nameAr: undefined });
      const generic = await render(store(), 'ar', noApi());
      const result = await render(
        store(),
        'ar',
        okFetch({ name: 'Merchant App', short_name: 'Merchant' })
      );
      expect(result).toStrictEqual({ ...generic, name: 'Merchant App', short_name: 'Merchant' });
    });

    // The API-manifest branch used to skip `pickMetaDescription` and answer "Shop at <name>" whenever no PWA
    // description was saved, even for a store that wrote its own description.
    it.each([
      ['en', 'Handmade leather, made in Cairo'],
      ['ar', 'جلد طبيعي صناعة يدوية في القاهرة'],
    ])(
      '%s: no PWA description saved → the store OWN description, never "Shop at"',
      async (lang, own) => {
        const result = await render(
          richStore(),
          lang,
          okFetch({ name: 'Merchant App', name_ar: 'تطبيق التاجر', theme_color: '#123456' })
        );
        expect(result.description).toBe(own);
      }
    );

    it('everything saved: nothing generic is left but what was not offered', async () => {
      const saved = {
        name: 'Merchant App',
        short_name: 'Merchant',
        description: 'Our own words',
        theme_color: '#123456',
        background_color: '#fefefe',
        display: 'minimal-ui',
        orientation: 'portrait',
        start_url: '/offers',
        scope: '/',
        icons: [{ ...httpsIcon, purpose: 'maskable' }],
      };
      expect(await render(richStore(), 'en', okFetch(saved))).toStrictEqual(saved);
    });
  });

  describe('3. the schema takes a manifest with members absent', () => {
    it('{} parses to {}: no member is required and none is filled in', async () => {
      const { storePwaManifestSchema } = await import('@ebda/shared');
      const parsed = storePwaManifestSchema.safeParse({});
      expect(parsed.success).toBe(true);
      expect(parsed.success && parsed.data).toStrictEqual({});
    });

    it('every member parses on its own, and the result carries no other member', async () => {
      const { storePwaManifestSchema } = await import('@ebda/shared');
      const members: Record<string, unknown> = {
        name: 'Merchant App',
        short_name: 'Merchant',
        description: 'Our own words',
        name_ar: 'تطبيق التاجر',
        short_name_ar: 'التاجر',
        description_ar: 'كلامنا إحنا',
        theme_color: '#123456',
        background_color: '#fefefe',
        display: 'minimal-ui',
        orientation: 'portrait',
        start_url: '/offers',
        scope: '/',
        icons: [httpsIcon],
      };
      // the list above is the whole schema: a member added to it without a case here fails
      expect(Object.keys(members).sort()).toEqual(Object.keys(storePwaManifestSchema.shape).sort());
      for (const [member, value] of Object.entries(members)) {
        const parsed = storePwaManifestSchema.safeParse({ [member]: value });
        expect(parsed.success, member).toBe(true);
        expect(parsed.success && parsed.data, member).toStrictEqual({ [member]: value });
      }
    });
  });
});

describe('manifest: the language in the URL decides, a cookie the browser never sends does not (Ruling PWA-MANIFEST-2)', () => {
  const noSaved = () => {
    global.fetch = vi.fn(async () => ({ ok: false })) as unknown as typeof fetch;
  };

  it('/en/manifest.webmanifest on an Arabic-default store, no cookie: English', async () => {
    storeRef.current = makeStore({ settings: { defaultLanguage: 'ar' } });
    urlRef.lang = 'en';
    noSaved();
    const result = await manifest();
    expect(result.name).toBe('Demo Shop');
    expect(result.description).not.toMatch(/[\u0600-\u06FF]/);
  });

  it('/ar/manifest.webmanifest on an English-default store, no cookie: Arabic', async () => {
    storeRef.current = makeStore({ settings: { defaultLanguage: 'en' } });
    urlRef.lang = 'ar';
    noSaved();
    const result = await manifest();
    expect(result.name).toBe('وادي الجوز');
    expect(result.description).toMatch(/[\u0600-\u06FF]/);
  });

  it('the URL language beats a cookie that says otherwise', async () => {
    storeRef.current = makeStore({ settings: { defaultLanguage: 'ar' } });
    urlRef.lang = 'ar';
    cookieRef.lang = 'en';
    noSaved();
    expect((await manifest()).name).toBe('وادي الجوز');
  });

  it('the shared /manifest.webmanifest with no cookie keeps the store default, byte for byte', async () => {
    storeRef.current = makeStore({ settings: { defaultLanguage: 'ar' } });
    noSaved();
    const shared = JSON.stringify(await manifest());
    urlRef.lang = 'ar';
    expect(JSON.stringify(await manifest())).toBe(shared);
    urlRef.lang = 'en';
    expect(JSON.stringify(await manifest())).not.toBe(shared);
  });
});
