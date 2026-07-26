import { describe, expect, it, afterEach } from 'vitest';
import { storeAbsoluteUrl } from './structured-data';
import type { ResolvedStore } from './store-resolver';

describe('storeAbsoluteUrl', () => {
  const originalSiteUrl = process.env.NEXT_PUBLIC_SITE_URL;

  afterEach(() => {
    if (originalSiteUrl === undefined) delete process.env.NEXT_PUBLIC_SITE_URL;
    else process.env.NEXT_PUBLIC_SITE_URL = originalSiteUrl;
  });

  it('includes the /<slug> path prefix for a platform-path store (no custom domain)', () => {
    delete process.env.NEXT_PUBLIC_SITE_URL;
    const store = {
      id: 'store-1',
      slug: 'my-store',
      domain: undefined,
    } as unknown as ResolvedStore;

    expect(storeAbsoluteUrl(store, '/products/widget')).toBe(
      'https://store.force-ai.co/my-store/products/widget'
    );
  });

  it('omits the slug prefix for a custom-domain store (byte-identical to bare getSiteUrl + path)', () => {
    delete process.env.NEXT_PUBLIC_SITE_URL;
    const store = {
      id: 'store-1',
      slug: 'my-store',
      domain: 'example.com',
    } as unknown as ResolvedStore;

    expect(storeAbsoluteUrl(store, '/products/widget')).toBe('https://example.com/products/widget');
  });

  it('handles a path with no leading slash the same as one with a leading slash', () => {
    delete process.env.NEXT_PUBLIC_SITE_URL;
    const store = {
      id: 'store-1',
      slug: 'my-store',
      domain: undefined,
    } as unknown as ResolvedStore;

    expect(storeAbsoluteUrl(store, 'products/widget')).toBe(
      storeAbsoluteUrl(store, '/products/widget')
    );
  });

  it('resolves an empty or "/" path to the bare store root', () => {
    delete process.env.NEXT_PUBLIC_SITE_URL;
    const store = {
      id: 'store-1',
      slug: 'my-store',
      domain: undefined,
    } as unknown as ResolvedStore;

    expect(storeAbsoluteUrl(store, '')).toBe('https://store.force-ai.co/my-store');
    expect(storeAbsoluteUrl(store, '/')).toBe('https://store.force-ai.co/my-store/');
  });
});
