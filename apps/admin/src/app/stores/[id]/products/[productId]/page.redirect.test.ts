/**
 * UX:PE-3 - the old read-only product page URL still works: it redirects to the edit page's overview tab and keeps
 * `returnTo`. No URL is removed.
 */
import { describe, expect, it, vi } from 'vitest';

const redirect = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({ redirect }));

import ProductViewRedirectPage from './page';

describe('product view URL', () => {
  it('redirects to the edit overview tab and keeps returnTo', async () => {
    await ProductViewRedirectPage({
      params: Promise.resolve({ id: 's1', productId: 'p1' }),
      searchParams: Promise.resolve({ returnTo: '/stores/s1/products?page=2' }),
    });
    expect(redirect).toHaveBeenCalledWith(
      '/stores/s1/products/p1/edit?tab=overview&returnTo=%2Fstores%2Fs1%2Fproducts%3Fpage%3D2'
    );
  });
  it('works without returnTo', async () => {
    redirect.mockClear();
    await ProductViewRedirectPage({
      params: Promise.resolve({ id: 's1', productId: 'p1' }),
      searchParams: Promise.resolve({}),
    });
    expect(redirect).toHaveBeenCalledWith('/stores/s1/products/p1/edit?tab=overview');
  });
});
