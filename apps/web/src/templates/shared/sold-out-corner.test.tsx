// @vitest-environment jsdom
/**
 * X-01 (Lookbook/Vitrine taste gate 2026-10-15): one corner allocator per card.
 * The sold-out ribbon sat at top-start under the wishlist heart (the shared card's
 * heart lives there), every store. `soldOutCorner` now places it, and the sale
 * chip's pin reads the same answer, so heart, ribbon and sale chip never share a
 * corner.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { render, cleanup } from '@testing-library/react';
import { soldOutCorner } from './badge-collision';
import { pinDefaultDiscountBadge } from './custom-badge';

const languageState = { language: 'en' as 'en' | 'ar' };
const layoutState = { layout: undefined as unknown };
vi.mock('../../contexts/StoreContext', () => ({
  useStore: () => ({
    store: { id: 's', name: 'S', slug: 's', currency: 'EGP', theme: {} },
    layout: layoutState.layout,
  }),
  useStoreUrl: () => (p: string) => p,
  useStoreTemplate: () => 'modern',
}));
vi.mock('../../contexts/LanguageContext', () => ({
  useLanguage: () => ({
    language: languageState.language,
    isRtl: languageState.language === 'ar',
    t: (en: string, ar?: string) => (languageState.language === 'ar' ? (ar ?? en) : en),
    setLanguage: () => {},
  }),
  translations: {} as Record<string, string>,
}));
vi.mock('next/image', () => ({
  __esModule: true,
  default: ({ src, alt }: { src: string; alt?: string }) =>
    React.createElement('img', { src, alt }),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, prefetch: () => {}, replace: () => {} }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('next/link', () => ({
  __esModule: true,
  default: ({
    href,
    children,
    prefetch: _p,
    ...rest
  }: React.PropsWithChildren<{ href: string; prefetch?: boolean }>) =>
    React.createElement('a', { href, ...rest }, children),
}));

afterEach(cleanup);

describe('soldOutCorner', () => {
  it('top-start by default; top-end when a button holds top-start; bottom when both are held', () => {
    expect(soldOutCorner({})).toEqual({ v: 'top', h: 'start' });
    expect(soldOutCorner({ topEndReserved: true })).toEqual({ v: 'top', h: 'start' });
    expect(soldOutCorner({ topStartReserved: true })).toEqual({ v: 'top', h: 'end' });
    expect(soldOutCorner({ topStartReserved: true, topEndReserved: true })).toEqual({
      v: 'bottom',
      h: 'start',
    });
  });

  it('the sale chip pin plans around the ribbon: heart at start + ribbon at end → chip below the heart', () => {
    // English: start = left. The ribbon takes top-right, so the chip must not.
    expect(
      pinDefaultDiscountBadge({ isRtl: false, orderable: false, topStartReserved: true }).corner
    ).toBe('top-left');
    // Arabic: start = right; the ribbon takes top-left.
    expect(
      pinDefaultDiscountBadge({ isRtl: true, orderable: false, topStartReserved: true }).corner
    ).toBe('top-right');
    // No heart: ribbon at start, chip at end (unchanged behaviour).
    expect(pinDefaultDiscountBadge({ isRtl: false, orderable: false }).corner).toBe('top-right');
  });
});

describe('X-01 on the cards', () => {
  it.each(['en', 'ar'] as const)(
    'shared card (%s): the ribbon leaves the heart corner; the sale chip leaves the ribbon corner',
    async lang => {
      languageState.language = lang;
      const { StorefrontProductCard } = await import('./StorefrontProductCard');
      const { container } = render(
        <StorefrontProductCard
          product={
            {
              id: 'p1',
              name: 'Linen',
              nameAr: 'كتان',
              slug: 'linen',
              price: 5000,
              compareAtPrice: 8000,
              images: [{ id: 'i', url: 'https://example.test/a.jpg', alt: 'a' }],
              inStock: false,
            } as never
          }
          isRtl={lang === 'ar'}
          onAddToWishlist={() => {}}
        />
      );
      const heart = container.querySelector('button[aria-pressed]')!;
      expect(heart.className).toContain('start-3');
      const ribbon = container.querySelector('[data-oos-corner]')!;
      expect(ribbon.getAttribute('data-oos-corner')).toBe('top-end');
      expect(ribbon.className).toContain('end-0');
      // The ribbon physically sits on the END side: right in English, left in Arabic.
      const ribbonSide = lang === 'en' ? 'right' : 'left';
      const chip = Array.from(container.querySelectorAll('span')).find(s =>
        s.textContent?.includes('−38%')
      )!;
      expect(chip, 'sale chip rendered').toBeTruthy();
      expect(chip.className).not.toMatch(new RegExp(`(^|\\s)${ribbonSide}-`));
    }
  );

  it('both top corners held (compare + heart): the marker drops to the bottom edge', async () => {
    const { OutOfStockRibbon } = await import('./ProductCardCta');
    const { container } = render(
      <OutOfStockRibbon inStock={false} topStartReserved topEndReserved />
    );
    expect(container.querySelector('[data-oos-corner]')?.getAttribute('data-oos-corner')).toBe(
      'bottom-start'
    );
  });

  it('no button on the card: the ribbon keeps its top-start home (no change for those stores)', async () => {
    const { OutOfStockRibbon } = await import('./ProductCardCta');
    const { container } = render(<OutOfStockRibbon inStock={false} />);
    const el = container.querySelector('[data-oos-corner]')!;
    expect(el.getAttribute('data-oos-corner')).toBe('top-start');
    expect(el.className).toContain('start-0');
  });
});

describe('X-01 (fix round): a MERCHANT-placed sale chip and the sold-out marker never stack', () => {
  const OOS_ON_SALE = {
    id: 'p2',
    name: 'Linen',
    nameAr: 'كتان',
    slug: 'linen',
    price: 5000,
    compareAtPrice: 8000,
    images: [{ id: 'i', url: 'https://example.test/a.jpg', alt: 'a' }],
    inStock: false,
  };
  afterEach(() => {
    layoutState.layout = undefined;
  });

  it.each(['en', 'ar'] as const)(
    'shared card (%s): heart at start + merchant chip at the end corner → the marker drops to the bottom',
    async lang => {
      languageState.language = lang;
      // The END corner physically: right in English, left in Arabic.
      layoutState.layout = {
        productCardDefaults: {
          discountBadge: { position: lang === 'en' ? 'top-right' : 'top-left' },
        },
      };
      const { StorefrontProductCard } = await import('./StorefrontProductCard');
      const { container } = render(
        <StorefrontProductCard
          product={OOS_ON_SALE as never}
          isRtl={lang === 'ar'}
          onAddToWishlist={() => {}}
        />
      );
      expect(container.querySelector('[data-oos-corner]')?.getAttribute('data-oos-corner')).toBe(
        'bottom-start'
      );
    }
  );

  it('classic card: merchant chip at the START corner → the ribbon takes the end corner', async () => {
    languageState.language = 'en';
    layoutState.layout = { productCardDefaults: { discountBadge: { position: 'top-left' } } };
    const { default: ClassicProductCard } = await import('../classic/ProductCard');
    const { container } = render(
      <ClassicProductCard product={OOS_ON_SALE as never} isRtl={false} />
    );
    expect(container.querySelector('[data-oos-corner]')?.getAttribute('data-oos-corner')).toBe(
      'top-end'
    );
  });
});
