import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('../../contexts/StoreContext', () => ({
  useStore: () => ({
    store: { id: 's1', name: 'S', slug: 's', currency: 'EGP', theme: {} },
    layout: undefined,
  }),
  useStoreUrl: () => (p: string) => p,
  useStoreTemplate: () => 'minimal',
}));
vi.mock('../../contexts/LanguageContext', () => ({
  useLanguage: () => ({
    language: 'en',
    isRtl: false,
    t: (en: string) => en,
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
    prefetch,
    ...rest
  }: React.PropsWithChildren<{ href: string; prefetch?: boolean }>) =>
    React.createElement('a', { href, 'data-prefetch': String(prefetch), ...rest }, children),
}));

const { default: MinimalProductCard } = await import('./ProductCard');
const { getPackStyles } = await import('../shared/pack-styles');

const LONG = {
  id: 'p1',
  name: 'Handembroideredlinenkaftanwithsilkpiping Evening Edition',
  slug: 'kaftan',
  price: 5000,
  images: [{ id: 'i1', url: 'https://example.test/a.jpg', alt: 'a' }],
  inStock: true,
};

describe('minimal card overflow (B0-46)', () => {
  const html = renderToStaticMarkup(
    React.createElement(
      MinimalProductCard as never,
      { product: LONG, isRtl: false, currency: 'EGP' } as never
    )
  );

  it('a long unbroken name wraps instead of running out of the card', () => {
    const name =
      /<h3[^>]*data-zone="productName"[^>]*class="([^"]*)"/.exec(html) ??
      /<h3[^>]*class="([^"]*)"[^>]*data-zone="productName"/.exec(html);
    expect(name?.[1]).toContain('[overflow-wrap:anywhere]');
  });

  it('the quick-add link fits the card: padded overlay, tighter tracking, ellipsis not clip', () => {
    expect(html).toContain('px-3 pb-4 pt-12');
    expect(html).toMatch(/max-w-full overflow-hidden text-ellipsis[^"]*tracking-\[0\.14em\]/);
    expect(html).not.toContain('tracking-[0.28em]');
  });

  it('the recommendation carousel pack style matches (44vw cards)', () => {
    const m = getPackStyles('minimal');
    expect(m.productCardName).toContain('[overflow-wrap:anywhere]');
    expect(m.productCardCta).toContain('max-w-full');
    expect(m.productCardCta).toContain('tracking-[0.14em]');
    expect(m.productCardCta).not.toContain('tracking-[0.28em]');
  });
});

// FU46 / D7: the fix lands on EVERY card render path, not just minimal.
describe('every card render path wraps long names and fits its CTA (FU46 D7)', () => {
  it.each(['modern', 'elegant', 'classic', 'minimal', 'bold', 'dahab'] as const)(
    'pack %s: name wraps anywhere, CTA is bounded and never a bare nowrap',
    pack => {
      const s = getPackStyles(pack);
      expect(s.productCardName).toContain('[overflow-wrap:anywhere]');
      expect(s.productCardCta).toContain('max-w-full');
      expect(s.productCardCta).toContain('overflow-hidden');
    }
  );

  it.each([
    'modern/ProductCard.tsx',
    'elegant/ProductCard.tsx',
    'classic/ProductCard.tsx',
    'minimal/ProductCard.tsx',
    'bold/ProductCard.tsx',
    'dahab/ProductCard.tsx',
    'shared/PecannbeeProductCard.tsx',
    'shared/ProductCarousel.tsx',
    '../app/products/ProductListItem.tsx',
  ])('%s keeps [overflow-wrap:anywhere] on the product name', file => {
    const src = readFileSync(resolve(__dirname, '..', file), 'utf8');
    expect(src).toContain('[overflow-wrap:anywhere]');
  });
});
