import { describe, it, expect, vi, afterEach } from 'vitest';
import { notFound } from 'next/navigation';
import type { ReactElement, ReactNode } from 'react';
import type { ResolvedStore } from '../../lib/store-resolver';

/**
 * Exercises the ACTUAL feature-gating decision inside `BundlesPageBody`:
 * a store WITHOUT the `bundles` feature (403 `FEATURE_DISABLED`) must get a
 * real 404 for `/bundles` — "no page" is this branch's central safety
 * promise (see the hard requirements in the product-bundles storefront
 * plan) — while a store WITH the feature renders, whether or not it
 * currently has any purchasable bundles (an empty catalog is a normal 200,
 * never conflated with the feature being off). Same technique as
 * `products/[slug]/ProductDetailBody.test.tsx`: `notFound()` throws in real
 * Next.js, so we invoke the async server component directly and assert on
 * what it threw / the props it handed to `BundlesClient`, rather than
 * rendering JSX through a DOM harness (none is installed in this repo).
 */

vi.mock('next/navigation', () => ({
  notFound: vi.fn(() => {
    throw new Error('__NOT_FOUND__');
  }),
}));

// Imported AFTER the mock above so it picks up the mocked navigation module.
import { BundlesPageBody } from './BundlesPageBody';
import BundlesClient from './BundlesClient';

const mockedNotFound = vi.mocked(notFound);

function makeFetchMock(bundlesResponse: { ok: boolean; status: number; bundles?: unknown[] }) {
  return vi.fn(async () => ({
    ok: bundlesResponse.ok,
    status: bundlesResponse.status,
    json: async () => ({ data: { bundles: bundlesResponse.bundles ?? [] } }),
  }));
}

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  vi.clearAllMocks();
});

/** Digs the `<BundlesClient bundles={...} />` element out of the fragment
 *  `BundlesPageBody` returns, so we can assert on the exact prop it was
 *  handed without a DOM-rendering harness. */
function findBundlesClientProps(element: ReactElement): { bundles: unknown[] } {
  const children = (element.props as { children: ReactNode }).children;
  const list = Array.isArray(children) ? children : [children];
  const match = list.find(
    (child): child is ReactElement =>
      !!child && typeof child === 'object' && (child as ReactElement).type === BundlesClient
  );
  if (!match) throw new Error('BundlesClient element not found in BundlesPageBody output');
  return match.props as { bundles: unknown[] };
}

describe('BundlesPageBody — feature gating (403-means-404)', () => {
  it('a store WITHOUT the bundles feature (403) gets a real 404, not an empty page', async () => {
    global.fetch = makeFetchMock({ ok: false, status: 403 }) as unknown as typeof fetch;
    const store = { id: 'store1', slug: 'pecan', domain: undefined } as unknown as ResolvedStore;

    await expect(BundlesPageBody({ store })).rejects.toThrow('__NOT_FOUND__');
    expect(mockedNotFound).toHaveBeenCalledTimes(1);
  });

  it('a store WITH the feature and purchasable bundles renders — notFound never fires', async () => {
    const bundles = [
      { id: 'b1', name: 'Weekend Grill Box', slug: 'weekend-grill-box', price: 4000 },
    ];
    global.fetch = makeFetchMock({ ok: true, status: 200, bundles }) as unknown as typeof fetch;
    const store = {
      id: 'store1',
      slug: 'pecan',
      domain: undefined,
      currency: 'EGP',
    } as unknown as ResolvedStore;

    const element = await BundlesPageBody({ store });
    expect(mockedNotFound).not.toHaveBeenCalled();
    expect(findBundlesClientProps(element).bundles).toEqual(bundles);
  });

  it('a store WITH the feature but zero purchasable bundles still renders — empty catalog is NOT the feature being off', async () => {
    global.fetch = makeFetchMock({ ok: true, status: 200, bundles: [] }) as unknown as typeof fetch;
    const store = {
      id: 'store1',
      slug: 'pecan',
      domain: undefined,
      currency: 'EGP',
    } as unknown as ResolvedStore;

    const element = await BundlesPageBody({ store });
    expect(mockedNotFound).not.toHaveBeenCalled();
    expect(findBundlesClientProps(element).bundles).toEqual([]);
  });

  it('demo store passthrough: no fetch call, no notFound', async () => {
    global.fetch = vi.fn(async () => {
      throw new Error('fetch must not be called for the demo store');
    }) as unknown as typeof fetch;
    const store = { id: 'demo', slug: 'demo', domain: undefined } as unknown as ResolvedStore;

    const element = await BundlesPageBody({ store });
    expect(mockedNotFound).not.toHaveBeenCalled();
    expect(findBundlesClientProps(element).bundles).toEqual([]);
  });
});
