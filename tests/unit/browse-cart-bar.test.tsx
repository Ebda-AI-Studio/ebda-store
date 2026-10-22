// @vitest-environment jsdom
/**
 * Phase B4 Task 2, Ruling B4-6: the browse cart bar. Look data (chrome.cartBar) turns it on; it
 * shows on home, list, category and search only, while a basket exists; it REPLACES the tab bar
 * (C-04: <html data-task-bar>) and never stacks with the PDP buy bar or the cart total bar.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import React from 'react';
import { render, cleanup } from '@testing-library/react';
import { smallTargets } from '../helpers/target-size';

const ctx = vi.hoisted(() => ({
  look: 'lamma.market' as string | null,
  path: '/',
  itemCount: 2,
  total: 9000,
  minimum: undefined as number | undefined,
}));

vi.mock('next/link', () => ({
  default: ({ children, href, ...p }: { children: React.ReactNode; href: string }) => (
    <a href={href} {...p}>
      {children}
    </a>
  ),
}));
vi.mock('next/navigation', () => ({ usePathname: () => ctx.path }));
vi.mock('../../apps/web/src/contexts/StoreContext', () => ({
  useStore: () => ({
    store: { id: 's', look: ctx.look, settings: { minimumOrderFils: ctx.minimum } },
  }),
  useStoreUrl: () => (p: string) => p,
}));
vi.mock('../../apps/web/src/contexts/CartContext', () => ({
  useCart: () => ({ itemCount: ctx.itemCount, total: ctx.total }),
}));
vi.mock('../../apps/web/src/contexts/LanguageContext', () => ({
  useLanguage: () => ({
    language: 'ar',
    isRtl: true,
    t: (_en: string, ar: string) => ar,
  }),
}));
vi.mock('../../apps/web/src/hooks/useLocalePrice', () => ({
  useLocalePrice: () => (fils: number) => `${fils / 100} ج.م`,
}));
vi.mock('../../apps/web/src/hooks/useNumerals', () => ({
  useNumerals: () => ({ localize: (n: number) => String(n) }),
}));

const { StickyBrowseCartBar, browseBarShownOn } =
  await import('../../apps/web/src/components/commerce/StickyBrowseCartBar');

beforeEach(() => {
  ctx.look = 'lamma.market';
  ctx.path = '/';
  ctx.itemCount = 2;
  ctx.total = 9000;
  ctx.minimum = undefined;
});
afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute('data-task-bar');
  delete document.body.dataset.stickyCart;
});

describe('browseBarShownOn', () => {
  it('shows on home, list, categories and search, with or without a store prefix', () => {
    for (const p of [
      '/',
      '/products',
      '/products/',
      '/categories',
      '/categories/tagines',
      '/search',
    ])
      expect(browseBarShownOn(p), p).toBe(true);
    expect(browseBarShownOn('/s/lamma-table', '/s/lamma-table')).toBe(true);
    expect(browseBarShownOn('/s/lamma-table/categories/x', '/s/lamma-table')).toBe(true);
  });
  it('never on a product page, the cart, checkout, account or content pages', () => {
    for (const p of [
      '/products/okra',
      '/cart',
      '/checkout',
      '/account/orders',
      '/about',
      '/auth/login',
    ])
      expect(browseBarShownOn(p), p).toBe(false);
    expect(browseBarShownOn('/s/lamma-table/products/okra', '/s/lamma-table')).toBe(false);
  });
});

describe('StickyBrowseCartBar', () => {
  it('shows count, shared-format total and the cart link on a cartBar look', () => {
    const { getByTestId, container } = render(<StickyBrowseCartBar />);
    expect(getByTestId('sticky-browse-cart-total').textContent).toBe('90 ج.م');
    expect(container.textContent).toContain('قطعتين');
    const link = container.querySelector('a[href="/cart"]')!;
    expect(link.textContent).toBe('عرض السلة');
    expect(smallTargets(container, 44)).toEqual([]);
  });
  it('marks <html data-task-bar> so the tab bar is replaced, and clears it on unmount', () => {
    const { unmount } = render(<StickyBrowseCartBar />);
    expect(document.documentElement.hasAttribute('data-task-bar')).toBe(true);
    expect(document.body.dataset.stickyCart).toBe('1');
    unmount();
    expect(document.documentElement.hasAttribute('data-task-bar')).toBe(false);
    expect(document.body.dataset.stickyCart).toBeUndefined();
  });
  it('is one fixed-bottom layer: phone-only, safe-area padded, and the single bar in the DOM', () => {
    const { container } = render(<StickyBrowseCartBar />);
    const bars = container.querySelectorAll('.fixed.bottom-0');
    expect(bars).toHaveLength(1);
    expect(bars[0].className).toContain('md:hidden');
    expect(bars[0].className).toContain('safe-area-inset-bottom');
  });
  it('renders nothing with an empty cart, off a browse route, or on a look without cartBar', () => {
    ctx.itemCount = 0;
    expect(render(<StickyBrowseCartBar />).container.innerHTML).toBe('');
    cleanup();
    ctx.itemCount = 2;
    ctx.path = '/products/okra';
    expect(render(<StickyBrowseCartBar />).container.innerHTML).toBe('');
    cleanup();
    ctx.path = '/';
    for (const look of ['qamar.atelier', 'souq.night', null]) {
      ctx.look = look;
      expect(render(<StickyBrowseCartBar />).container.innerHTML, String(look)).toBe('');
      expect(document.documentElement.hasAttribute('data-task-bar')).toBe(false);
      cleanup();
    }
  });
  it('carries the minimum-order progress and the taller body reservation while under the minimum', () => {
    ctx.minimum = 15000;
    const { getByTestId, getByRole } = render(<StickyBrowseCartBar />);
    expect(getByTestId('min-order-progress').textContent).toContain('ضيف 60 ج.م');
    expect(getByRole('progressbar')).toBeTruthy();
    expect(document.body.dataset.stickyCart).toBe('blocked');
  });
  it('shows no progress once the minimum is met, or when the store sets none', () => {
    ctx.minimum = 5000;
    expect(render(<StickyBrowseCartBar />).queryByTestId('min-order-progress')).toBeNull();
    cleanup();
    ctx.minimum = undefined;
    expect(render(<StickyBrowseCartBar />).queryByTestId('min-order-progress')).toBeNull();
  });
});
