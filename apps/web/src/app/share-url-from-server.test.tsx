import { describe, it, expect, vi, afterEach } from 'vitest';
import type { ReactElement } from 'react';
import type { ResolvedStore } from '../lib/store-resolver';

/**
 * B0-46 review I-2: the share row's URL comes from the SERVER (canonical, store-aware via
 * storeAbsoluteUrl), so the server HTML and a tap before hydration carry a real link.
 */
vi.mock('next/navigation', () => ({
  permanentRedirect: vi.fn(),
  notFound: vi.fn(() => {
    throw new Error('__NOT_FOUND__');
  }),
}));

import { ProductDetailBody } from './products/[slug]/ProductDetailBody';
import { BlogPostBody } from './blog/[slug]/BlogPostBody';

const originalFetch = global.fetch;
const originalSiteUrl = process.env.NEXT_PUBLIC_SITE_URL;
afterEach(() => {
  global.fetch = originalFetch;
  if (originalSiteUrl === undefined) delete process.env.NEXT_PUBLIC_SITE_URL;
  else process.env.NEXT_PUBLIC_SITE_URL = originalSiteUrl;
});

function findProps(
  node: unknown,
  pred: (p: Record<string, unknown>) => boolean
): Record<string, unknown> | undefined {
  if (!node || typeof node !== 'object') return undefined;
  if (Array.isArray(node)) {
    for (const n of node) {
      const f = findProps(n, pred);
      if (f) return f;
    }
    return undefined;
  }
  const el = node as ReactElement<Record<string, unknown>>;
  if (el.props && pred(el.props)) return el.props;
  return findProps(el.props?.children, pred);
}

const store = {
  id: 'store1',
  slug: 'pecan',
  domain: undefined,
  name: 'Pecan',
} as unknown as ResolvedStore;

function fetchMock(body: unknown) {
  return vi.fn(async (input: unknown) => {
    const url = String(input);
    if (url.includes('/public/products/') || url.includes('/blog/'))
      return { ok: true, status: 200, json: async () => ({ data: body }) };
    return { ok: true, status: 200, json: async () => ({ data: {} }) };
  });
}

describe('share url from server data (I-2)', () => {
  it('product page passes the canonical product url to the client', async () => {
    delete process.env.NEXT_PUBLIC_SITE_URL;
    global.fetch = fetchMock({
      product: { id: 'p1', slug: 'linen-abaya', name: 'Linen Abaya', images: [] },
    }) as unknown as typeof fetch;
    const tree = await ProductDetailBody({ store, slug: 'linen-abaya', draftToken: undefined });
    const props = findProps(tree, p => 'initialProduct' in p);
    expect(props?.shareUrl).toBe('https://pecan.ebda.app/products/linen-abaya');
  });
  it('blog page passes the canonical post url to the client', async () => {
    delete process.env.NEXT_PUBLIC_SITE_URL;
    global.fetch = fetchMock({
      post: { id: 'b1', slug: 'hello', title: 'Hello', createdAt: '2026-01-01' },
    }) as unknown as typeof fetch;
    const tree = await BlogPostBody({ store, slug: 'hello' });
    const props = findProps(tree, p => 'post' in p);
    expect(props?.shareUrl).toBe('https://pecan.ebda.app/blog/hello');
  });
});
