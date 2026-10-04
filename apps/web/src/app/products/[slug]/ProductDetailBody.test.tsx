import { describe, it, expect, vi, afterEach } from 'vitest';
import { permanentRedirect, notFound } from 'next/navigation';
import { fetchSlugRedirect } from '../../../lib/slug-redirect';
import { getSiteUrl } from '../../../lib/structured-data';
import type { ResolvedStore } from '../../../lib/store-resolver';

/**
 * Exercises the ACTUAL redirect-on-miss decision inside `ProductDetailBody`
 * (308 rename-redirect vs real 404 vs transient-error passthrough vs demo
 * passthrough) — the behavior that was previously only reviewed + covered
 * indirectly via `slug-redirect.test.ts`'s helper-unit tests. `permanentRedirect`
 * and `notFound` both throw in real Next.js (they never return), so on every
 * miss path we invoke the async server component and assert what it threw /
 * which navigation function fired, rather than rendering JSX.
 */

vi.mock('next/navigation', () => ({
  permanentRedirect: vi.fn((url: string) => {
    throw new Error(`__PERMANENT_REDIRECT__ ${url}`);
  }),
  notFound: vi.fn(() => {
    throw new Error('__NOT_FOUND__');
  }),
}));

vi.mock('../../../lib/slug-redirect', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../lib/slug-redirect')>();
  return {
    ...actual,
    fetchSlugRedirect: vi.fn(),
  };
});

// Imported AFTER the mocks above so it picks up the mocked navigation +
// slug-redirect modules.
import { ProductDetailBody } from './ProductDetailBody';

const mockedPermanentRedirect = vi.mocked(permanentRedirect);
const mockedNotFound = vi.mocked(notFound);
const mockedFetchSlugRedirect = vi.mocked(fetchSlugRedirect);

/** Benign layout response — `fetchProductDetailLayoutSettings` only needs
 *  `res.ok` + a `data.layout` shape it can pass through `resolveLayoutSettings`. */
const LAYOUT_RESPONSE = { ok: true, status: 200, json: async () => ({ data: { layout: {} } }) };

function makeFetchMock(productResponse: { ok: boolean; status: number }) {
  return vi.fn(async (input: unknown) => {
    const url = String(input);
    if (url.includes('/public/products/')) return productResponse;
    if (url.includes('/layout')) return LAYOUT_RESPONSE;
    throw new Error(`unexpected fetch url in test: ${url}`);
  });
}

const originalFetch = global.fetch;
const originalSiteUrl = process.env.NEXT_PUBLIC_SITE_URL;

afterEach(() => {
  global.fetch = originalFetch;
  if (originalSiteUrl === undefined) delete process.env.NEXT_PUBLIC_SITE_URL;
  else process.env.NEXT_PUBLIC_SITE_URL = originalSiteUrl;
  vi.clearAllMocks();
});

describe('ProductDetailBody — redirect-on-miss', () => {
  it('rename → 308: permanentRedirect fires with the <slug>.ebda.app store URL, notFound does not fire', async () => {
    delete process.env.NEXT_PUBLIC_SITE_URL;
    global.fetch = makeFetchMock({ ok: false, status: 404 }) as unknown as typeof fetch;
    mockedFetchSlugRedirect.mockResolvedValue('raw-pecan');

    const store = { id: 'store1', slug: 'pecan', domain: undefined } as unknown as ResolvedStore;

    await expect(
      ProductDetailBody({ store, slug: 'raw-pecan-2636297', draftToken: undefined })
    ).rejects.toThrow('__PERMANENT_REDIRECT__');

    const expectedUrl = `${getSiteUrl(store)}/products/raw-pecan`;
    expect(expectedUrl).toBe('https://pecan.ebda.app/products/raw-pecan');
    expect(mockedPermanentRedirect).toHaveBeenCalledTimes(1);
    expect(mockedPermanentRedirect).toHaveBeenCalledWith(expectedUrl);
    expect(mockedNotFound).not.toHaveBeenCalled();
  });

  it('rename → 308 on a custom-domain store: no /slug path prefix', async () => {
    delete process.env.NEXT_PUBLIC_SITE_URL;
    global.fetch = makeFetchMock({ ok: false, status: 404 }) as unknown as typeof fetch;
    mockedFetchSlugRedirect.mockResolvedValue('raw-pecan');

    const store = {
      id: 'store1',
      slug: 'pecan',
      domain: 'pecannbee.com.kw',
    } as unknown as ResolvedStore;

    await expect(
      ProductDetailBody({ store, slug: 'raw-pecan-2636297', draftToken: undefined })
    ).rejects.toThrow('__PERMANENT_REDIRECT__');

    expect(mockedPermanentRedirect).toHaveBeenCalledTimes(1);
    expect(mockedPermanentRedirect).toHaveBeenCalledWith(
      'https://pecannbee.com.kw/products/raw-pecan'
    );
    expect(mockedNotFound).not.toHaveBeenCalled();
  });

  it('genuine miss → real 404: notFound fires, permanentRedirect does not', async () => {
    global.fetch = makeFetchMock({ ok: false, status: 404 }) as unknown as typeof fetch;
    mockedFetchSlugRedirect.mockResolvedValue(null);

    const store = { id: 'store1', slug: 'pecan', domain: undefined } as unknown as ResolvedStore;

    await expect(
      ProductDetailBody({ store, slug: 'never-existed', draftToken: undefined })
    ).rejects.toThrow('__NOT_FOUND__');

    expect(mockedNotFound).toHaveBeenCalledTimes(1);
    expect(mockedPermanentRedirect).not.toHaveBeenCalled();
  });

  it('transient error (5xx) → throws through, NEITHER redirect nor 404 (soft-404-regression guard)', async () => {
    global.fetch = makeFetchMock({ ok: false, status: 500 }) as unknown as typeof fetch;
    mockedFetchSlugRedirect.mockResolvedValue(null);

    const store = { id: 'store1', slug: 'pecan', domain: undefined } as unknown as ResolvedStore;

    await expect(
      ProductDetailBody({ store, slug: 'raw-pecan', draftToken: undefined })
    ).rejects.toThrow('product fetch failed: 500');

    expect(mockedPermanentRedirect).not.toHaveBeenCalled();
    expect(mockedNotFound).not.toHaveBeenCalled();
    // The slug-redirect lookup must never even run for a transient error —
    // it's only reachable once `fetchInitialProduct` resolves to a genuine
    // (404) miss, and here it threw instead.
    expect(mockedFetchSlugRedirect).not.toHaveBeenCalled();
  });

  it('demo store passthrough: neither permanentRedirect nor notFound fires', async () => {
    // Demo store never fetches (`fetchInitialProduct`/`fetchProductDetailLayoutSettings`
    // both short-circuit on `store.id === 'demo'`) — a fetch mock that throws
    // on any call doubles as proof no network call happens.
    global.fetch = vi.fn(async () => {
      throw new Error('fetch must not be called for the demo store');
    }) as unknown as typeof fetch;

    const store = {
      id: 'demo',
      slug: 'demo',
      domain: undefined,
    } as unknown as ResolvedStore;

    await ProductDetailBody({ store, slug: 'anything', draftToken: undefined });

    expect(mockedPermanentRedirect).not.toHaveBeenCalled();
    expect(mockedNotFound).not.toHaveBeenCalled();
    expect(mockedFetchSlugRedirect).not.toHaveBeenCalled();
  });
});
