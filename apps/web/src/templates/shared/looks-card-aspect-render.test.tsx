/**
 * Looks (Phase S): the look's image ratio is the DEFAULT card image aspect on
 * every card render path, below every merchant choice (Ruling LOOKS-3), and a
 * store with no look renders byte-identically to before.
 */
import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { StoreLayoutSettings } from '@ebda/shared';

const storeState = {
  store: {
    id: 'store-1',
    name: 'Test Store',
    slug: 'test',
    currency: 'EGP',
    theme: {} as Record<string, unknown>,
    look: null as string | null,
  },
  layout: undefined as StoreLayoutSettings | undefined,
};
const languageState = { language: 'en' as 'en' | 'ar' };

vi.mock('../../contexts/StoreContext', () => ({
  useStore: () => storeState,
  useStoreUrl: () => (path: string) => path,
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
  // `prefetch` is a Next-only prop; forwarding it to a bare <a> makes React
  // warn on every render and drowns the real assertions.
  default: ({
    href,
    children,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    prefetch: _prefetch,
    ...rest
  }: React.PropsWithChildren<{ href: string; prefetch?: boolean }>) =>
    React.createElement('a', { href, ...rest }, children),
}));

const { StorefrontProductCard } = await import('./StorefrontProductCard');
const { default: ModernProductCard } = await import('../modern/ProductCard');
const { default: ElegantProductCard } = await import('../elegant/ProductCard');
const { default: ClassicProductCard } = await import('../classic/ProductCard');
const { default: BoldProductCard } = await import('../bold/ProductCard');
const { default: MinimalProductCard } = await import('../minimal/ProductCard');
const { ProductCarousel } = await import('./ProductCarousel');
const { default: DahabProductCard } = await import('../dahab/ProductCard');

const PRODUCT = {
  id: 'p1',
  name: 'Item',
  nameAr: 'منتج',
  slug: 'item',
  price: 5000,
  images: [{ id: 'i1', url: 'https://example.test/a.jpg', alt: 'a' }],
  inStock: true,
};
const CARDS = [
  ['StorefrontProductCard', StorefrontProductCard],
  ['modern', ModernProductCard],
  ['elegant', ElegantProductCard],
  ['classic', ClassicProductCard],
  ['bold', BoldProductCard],
  ['minimal', MinimalProductCard],
  ['dahab', DahabProductCard],
] as const;

function render(
  Card: unknown,
  look: string | null,
  extra: Record<string, unknown> = {},
  carousel = false
) {
  storeState.store.look = look;
  return renderToStaticMarkup(
    React.createElement(
      Card as never,
      carousel
        ? { products: [PRODUCT] as never, isRtl: false, currency: 'EGP', ...extra }
        : { product: PRODUCT as never, isRtl: false, currency: 'EGP', ...extra }
    )
  );
}
const RATIO = 'aspect-[var(--image-ratio,4/5)]';

describe.each(CARDS)('%s: look image ratio', (_n, Card) => {
  it('legacy store: no look class', () => {
    expect(render(Card, null)).not.toContain('image-ratio');
    expect(render(Card, 'nope.unknown')).toBe(render(Card, null));
  });
  it('look store, no merchant aspect: look ratio is the default', () => {
    expect(render(Card, 'qamar.atelier')).toContain(RATIO);
  });
});

describe.each(CARDS.filter(([n]) => n !== 'dahab'))(
  '%s: merchant aspect wins over the look',
  (_n, Card) => {
    it('cardImageAspect 1:1 beats the look', () => {
      const html = render(Card, 'qamar.atelier', { cardImageAspect: '1:1' });
      expect(html).toContain('aspect-square');
      expect(html).not.toContain(RATIO);
    });
  }
);

describe('ProductCarousel: look image ratio', () => {
  it('legacy: none; look: default; merchant cardImageAspect wins', () => {
    expect(render(ProductCarousel, null, {}, true)).not.toContain('image-ratio');
    expect(render(ProductCarousel, 'qamar.atelier', {}, true)).toContain(RATIO);
    const m = render(ProductCarousel, 'qamar.atelier', { cardImageAspect: '4:5' }, true);
    expect(m).toContain('aspect-[4/5]');
    expect(m).not.toContain(RATIO);
  });
});
