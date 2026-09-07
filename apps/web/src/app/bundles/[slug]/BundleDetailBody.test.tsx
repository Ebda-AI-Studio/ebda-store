import { describe, it, expect, vi, afterEach } from 'vitest';
import { notFound } from 'next/navigation';
import type { ResolvedStore } from '../../../lib/store-resolver';

/**
 * Exercises `BundleDetailBody`'s miss-handling — mirrors
 * `products/[slug]/ProductDetailBody.test.tsx`'s approach (invoke the async
 * server component directly and assert on what it threw), trimmed for the
 * bundle page's simpler decision tree: there is no slug-redirect mechanism
 * for bundles, so EVERY miss (unknown slug, cross-store slug, a
 * deactivated bundle, or the `bundles` feature disabled for the store) is a
 * real 404 — never a redirect.
 */

vi.mock('next/navigation', () => ({
  notFound: vi.fn(() => {
    throw new Error('__NOT_FOUND__');
  }),
}));

// Imported AFTER the mock above so it picks up the mocked navigation module.
import { BundleDetailBody, fetchInitialBundle } from './BundleDetailBody';

const mockedNotFound = vi.mocked(notFound);

function makeFetchMock(bundleResponse: { ok: boolean; status: number; json?: () => unknown }) {
  return vi.fn(async () => bundleResponse);
}

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  vi.clearAllMocks();
});

describe('BundleDetailBody — miss handling', () => {
  it('genuine 404 (unknown slug, cross-store slug, or a deactivated bundle): notFound fires', async () => {
    global.fetch = makeFetchMock({ ok: false, status: 404 }) as unknown as typeof fetch;
    const store = { id: 'store1', slug: 'pecan', domain: undefined } as unknown as ResolvedStore;

    await expect(BundleDetailBody({ store, slug: 'never-existed' })).rejects.toThrow(
      '__NOT_FOUND__'
    );
    expect(mockedNotFound).toHaveBeenCalledTimes(1);
  });

  it('feature-disabled store (403 FEATURE_DISABLED) is indistinguishable from a 404: notFound fires', async () => {
    global.fetch = makeFetchMock({ ok: false, status: 403 }) as unknown as typeof fetch;
    const store = { id: 'store1', slug: 'pecan', domain: undefined } as unknown as ResolvedStore;

    await expect(BundleDetailBody({ store, slug: 'some-bundle' })).rejects.toThrow('__NOT_FOUND__');
    expect(mockedNotFound).toHaveBeenCalledTimes(1);
  });

  it('transient error (5xx) throws through — NOT a false 404 (soft-404-regression guard)', async () => {
    global.fetch = makeFetchMock({ ok: false, status: 500 }) as unknown as typeof fetch;
    const store = { id: 'store1', slug: 'pecan', domain: undefined } as unknown as ResolvedStore;

    await expect(BundleDetailBody({ store, slug: 'some-bundle' })).rejects.toThrow(
      'bundle fetch failed: 500'
    );
    expect(mockedNotFound).not.toHaveBeenCalled();
  });

  it('demo store passthrough: no fetch, no notFound', async () => {
    global.fetch = vi.fn(async () => {
      throw new Error('fetch must not be called for the demo store');
    }) as unknown as typeof fetch;

    const store = { id: 'demo', slug: 'demo', domain: undefined } as unknown as ResolvedStore;

    await BundleDetailBody({ store, slug: 'anything' });

    expect(mockedNotFound).not.toHaveBeenCalled();
  });
});

describe('fetchInitialBundle', () => {
  it('returns null (not an error) on 404', async () => {
    global.fetch = makeFetchMock({ ok: false, status: 404 }) as unknown as typeof fetch;
    const result = await fetchInitialBundle('slug', { id: 'store1' });
    expect(result).toBeNull();
  });

  it('returns null (not an error) on 403 (feature disabled)', async () => {
    global.fetch = makeFetchMock({ ok: false, status: 403 }) as unknown as typeof fetch;
    const result = await fetchInitialBundle('slug', { id: 'store1' });
    expect(result).toBeNull();
  });

  it('throws on a transient 5xx rather than returning null', async () => {
    global.fetch = makeFetchMock({ ok: false, status: 500 }) as unknown as typeof fetch;
    await expect(fetchInitialBundle('slug', { id: 'store1' })).rejects.toThrow(
      'bundle fetch failed: 500'
    );
  });

  it('returns the bundle from a 200 response', async () => {
    const bundlePayload = { id: 'b1', name: 'Ramadan Box', slug: 'ramadan-box' };
    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: { bundle: bundlePayload } }),
    })) as unknown as typeof fetch;
    const result = await fetchInitialBundle('ramadan-box', { id: 'store1' });
    expect(result).toEqual(bundlePayload);
  });

  it('returns null for the demo store without calling fetch', async () => {
    global.fetch = vi.fn(async () => {
      throw new Error('fetch must not be called for the demo store');
    }) as unknown as typeof fetch;
    const result = await fetchInitialBundle('slug', { id: 'demo' });
    expect(result).toBeNull();
  });
});
