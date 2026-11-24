import { describe, expect, it, vi, afterEach } from 'vitest';
import { fetchSlugRedirect, localizedRedirectUrl, storeRedirectUrl } from './slug-redirect';
import type { ResolvedStore } from './store-resolver';

// the language the middleware asserts on a prefixed storefront page (`x-locale-path`); `throw` = no request context
let localeHeader: string | null | 'throw' = null;
vi.mock('next/headers', () => ({
  headers: async () => {
    if (localeHeader === 'throw') throw new Error('no request context');
    return { get: (n: string) => (n === 'x-locale-path' ? localeHeader : null) };
  },
}));

describe('fetchSlugRedirect', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('returns toSlug on a 200 response', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ toSlug: 'new-handle' }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await fetchSlugRedirect({ id: 'store-1' }, 'product', 'old-handle');

    expect(result).toBe('new-handle');
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/public/redirects/resolve?type=product&slug=old-handle'),
      expect.objectContaining({
        next: { revalidate: 60 },
        headers: expect.objectContaining({ 'X-Store-ID': 'store-1' }),
      })
    );
  });

  it('returns null on a 404 response', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 404 });
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await fetchSlugRedirect({ id: 'store-1' }, 'product', 'ghost-slug');

    expect(result).toBeNull();
  });

  it('returns null on the 200 the API answers when there is no redirect', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ toSlug: null }) });
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await fetchSlugRedirect({ id: 'store-1' }, 'product', 'ghost-slug');

    expect(result).toBeNull();
  });

  it('returns null for the demo store without calling fetch', async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await fetchSlugRedirect({ id: 'demo' }, 'product', 'anything');

    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns null when the response body has no string toSlug', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await fetchSlugRedirect({ id: 'store-1' }, 'product', 'old-handle');

    expect(result).toBeNull();
  });

  it('returns null when fetch throws', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('network down'));
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await fetchSlugRedirect({ id: 'store-1' }, 'product', 'old-handle');

    expect(result).toBeNull();
  });

  it('forwards x-store-domain when present', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ toSlug: 'x' }) });
    global.fetch = fetchMock as unknown as typeof fetch;

    await fetchSlugRedirect({ id: 'store-1', domain: 'example.com' }, 'category', 'old-cat');

    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({ 'x-store-domain': 'example.com' }),
      })
    );
  });
});

describe('storeRedirectUrl', () => {
  const originalSiteUrl = process.env.NEXT_PUBLIC_SITE_URL;

  afterEach(() => {
    if (originalSiteUrl === undefined) delete process.env.NEXT_PUBLIC_SITE_URL;
    else process.env.NEXT_PUBLIC_SITE_URL = originalSiteUrl;
  });

  it('roots a store with no custom domain at <slug>.ebda.app, never a /<slug> path', () => {
    delete process.env.NEXT_PUBLIC_SITE_URL;
    const store = {
      id: 'store-1',
      slug: 'my-store',
      domain: undefined,
    } as unknown as ResolvedStore;

    const url = storeRedirectUrl(store, '/products/new-handle');

    expect(url).toBe('https://my-store.ebda.app/products/new-handle');
  });

  it('omits the slug prefix for a custom-domain store', () => {
    delete process.env.NEXT_PUBLIC_SITE_URL;
    const store = {
      id: 'store-1',
      slug: 'my-store',
      domain: 'example.com',
    } as unknown as ResolvedStore;

    const url = storeRedirectUrl(store, '/products/new-handle');

    expect(url).toBe('https://example.com/products/new-handle');
  });
});

describe('localizedRedirectUrl: a renamed-slug 308 keeps the language prefix (live: /ar/products/<old> lost /ar)', () => {
  const store = {
    id: 'store-1',
    slug: 'my-store',
    domain: 'example.com',
  } as unknown as ResolvedStore;
  afterEach(() => {
    localeHeader = null;
  });

  it('keeps /ar on a product rename', async () => {
    localeHeader = 'ar';
    expect(await localizedRedirectUrl(store, '/products/new-handle')).toBe(
      'https://example.com/ar/products/new-handle'
    );
  });
  it('keeps /en on a blog rename', async () => {
    localeHeader = 'en';
    expect(await localizedRedirectUrl(store, '/blog/new-post')).toBe(
      'https://example.com/en/blog/new-post'
    );
  });
  it('keeps the prefix AND the query on a category rename (/products?category=new)', async () => {
    localeHeader = 'ar';
    expect(await localizedRedirectUrl(store, '/products?category=new-cat')).toBe(
      'https://example.com/ar/products?category=new-cat'
    );
  });
  it('keeps the prefix with an encoded Arabic handle (the Location header stays ASCII)', async () => {
    localeHeader = 'ar';
    const url = await localizedRedirectUrl(store, `/products/${encodeURIComponent('خاتم-جديد')}`);
    expect(url).toBe(`https://example.com/ar/products/${encodeURIComponent('خاتم-جديد')}`);
    expect(/^[\x20-\x7e]+$/.test(url)).toBe(true);
  });
  it('an unprefixed page (no header), an unknown value, or no request context redirects to the unprefixed URL, as before', async () => {
    for (const v of [null, 'fr', '', 'throw'] as const) {
      localeHeader = v;
      expect(await localizedRedirectUrl(store, '/products/new-handle'), String(v)).toBe(
        'https://example.com/products/new-handle'
      );
    }
  });
  it('never doubles a prefix and leaves a non-indexable route alone', async () => {
    localeHeader = 'ar';
    expect(await localizedRedirectUrl(store, '/ar/products/x')).toBe(
      'https://example.com/ar/products/x'
    );
  });
});
