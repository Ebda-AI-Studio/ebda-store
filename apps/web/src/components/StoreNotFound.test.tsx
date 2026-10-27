// @vitest-environment jsdom
/**
 * 404-1c: a missing page INSIDE a store: the merchant's own brand, the store's typeahead, its top categories,
 * home / cart and "Surprise me". Never Ebda branding (the footer credit lives in the layout, not here).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { StoreNotFound } from './StoreNotFound';

const push = vi.fn();
const getProducts = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock('../lib/api', () => ({
  api: {
    getCategories: async () => ({
      success: true,
      data: {
        categories: [
          { id: '1', name: 'Shoes', nameAr: 'أحذية', slug: 'shoes' },
          { id: '2', name: 'Best', slug: 'best-sellers' },
        ],
      },
    }),
    getProducts: (...a: unknown[]) => getProducts(...a),
    searchSuggest: async () => ({ success: true, data: { suggestions: [] } }),
  },
}));
vi.mock('../contexts/StoreContext', () => ({ useStoreUrl: () => (p: string) => p }));
vi.mock('../contexts/LanguageContext', () => ({
  useLanguage: () => ({ language: 'ar', isRtl: true, t: (_en: string, ar: string) => ar }),
}));
vi.mock('../hooks/useLocalePrice', () => ({ useLocalePrice: () => (n: number) => String(n) }));
vi.mock('./SearchAutocomplete', () => ({ SearchAutocomplete: () => null }));

const store = { id: 's1', name: 'Amelia', nameAr: 'أميليا', logo: null, logoAr: null } as never;

afterEach(() => {
  cleanup();
  push.mockReset();
  getProducts.mockReset();
});

describe('StoreNotFound', () => {
  it('shows the store name, the one-line message, a search box, home, cart and categories', async () => {
    render(<StoreNotFound store={store} />);
    await act(async () => {});
    expect(screen.getByText('أميليا')).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(
      'الصفحة اللي بتدوّر عليها مش موجودة.'
    );
    expect(screen.getByRole('search')).toBeTruthy();
    expect(screen.getByRole('searchbox')).toBeTruthy();
    const hrefs = screen.getAllByRole('link').map(a => a.getAttribute('href'));
    expect(hrefs).toContain('/');
    expect(hrefs).toContain('/cart');
    expect(hrefs).toContain('/products?category=shoes');
    expect(hrefs).not.toContain('/products?category=best-sellers');
    expect(screen.getByText('أحذية')).toBeTruthy();
  });

  it('carries no Ebda branding and no orange of its own', () => {
    const { container } = render(<StoreNotFound store={store} />);
    expect(container.innerHTML).not.toMatch(/ebda\.app|ابدأ ستور|Ebda/);
    expect(container.innerHTML).not.toMatch(/orange|#ff6e01/i);
  });

  it('Surprise me opens a random in-stock product of this store', async () => {
    getProducts.mockResolvedValue({
      success: true,
      data: {
        products: [
          { slug: 'sold', inStock: false },
          { slug: 'lucky', inStock: true },
        ],
        meta: { total: 2 },
      },
    });
    render(<StoreNotFound store={store} />);
    await act(async () => {});
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /فاجئني/ }));
    });
    expect(push).toHaveBeenCalledWith('/products/lucky');
  });

  it('says so, in Arabic, when nothing is in stock', async () => {
    getProducts.mockResolvedValue({
      success: true,
      data: { products: [{ slug: 'sold', inStock: false }], meta: { total: 1 } },
    });
    render(<StoreNotFound store={store} />);
    await act(async () => {});
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /فاجئني/ }));
    });
    expect(push).not.toHaveBeenCalled();
    expect(screen.getByRole('status').textContent).toContain('مفيش منتج متاح');
  });
});
