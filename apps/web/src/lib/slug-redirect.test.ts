import { describe, expect, it, vi, afterEach } from 'vitest';
import { fetchSlugRedirect, storeRedirectUrl } from './slug-redirect';
import type { ResolvedStore } from './store-resolver';

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
