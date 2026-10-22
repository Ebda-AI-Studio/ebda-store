// @vitest-environment jsdom
/**
 * FU46 / D7: long names and the add-to-cart CTA must fit every card.
 *
 * jsdom has no layout engine, so these tests assert what the RENDERED markup
 * says (the classes that make a name wrap and a CTA fit, per card path, per
 * pack) and what the CTA component DOES when its box is too narrow (swap to the
 * icon-only button; metrics stubbed). The layout itself is proven by
 * `npm run test:card-overflow` (scripts/visual/measure-card-overflow.mjs).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { act, render as rtlRender, cleanup } from '@testing-library/react';
import { cn } from '@ebda/ui';

const state = {
  language: 'en' as 'en' | 'ar',
  template: 'minimal',
};

vi.mock('../../contexts/StoreContext', () => ({
  useStore: () => ({
    store: { id: 's1', name: 'S', slug: 's', currency: 'EGP', theme: {} },
    layout: undefined,
  }),
  useStoreUrl: () => (p: string) => p,
  useStoreTemplate: () => state.template,
}));
vi.mock('../../contexts/LanguageContext', () => ({
  useLanguage: () => ({
    language: state.language,
    isRtl: state.language === 'ar',
    t: (en: string, ar?: string) => (state.language === 'ar' ? (ar ?? en) : en),
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

const { StorefrontProductCard } = await import('./StorefrontProductCard');
const { default: ModernProductCard } = await import('../modern/ProductCard');
const { default: ElegantProductCard } = await import('../elegant/ProductCard');
const { default: ClassicProductCard } = await import('../classic/ProductCard');
const { default: BoldProductCard } = await import('../bold/ProductCard');
const { default: MinimalProductCard } = await import('../minimal/ProductCard');
const { ProductCarousel } = await import('./ProductCarousel');
const { ProductListItem } = await import('../../app/products/ProductListItem');
const { getPackStyles } = await import('./pack-styles');
const { ctaSizeClass } = await import('./card-size');
const { ProductCardCta, AdaptiveAddButton } = await import('./ProductCardCta');

const LONG = {
  id: 'p1',
  name: 'Handembroideredlinenkaftanwithsilkpiping Evening Edition',
  slug: 'kaftan',
  price: 5000,
  inventory: 5,
  images: [{ id: 'i1', url: 'https://example.test/a.jpg', alt: 'a' }],
  inStock: true,
};

const PACKS = ['modern', 'elegant', 'classic', 'minimal', 'bold', 'dahab'] as const;

function dom(html: string): HTMLElement {
  const root = document.createElement('div');
  root.innerHTML = html;
  return root;
}
function classes(el: Element | null): string[] {
  expect(el, 'element not rendered').not.toBeNull();
  return (el!.getAttribute('class') ?? '').split(/\s+/).filter(Boolean);
}
/** Unprefixed `tracking-[Nem]` values on an element (what a 320-390 phone gets). */
function mobileTracking(tokens: string[]): number[] {
  return tokens
    .map(t => /^tracking-\[([\d.]+)em\]$/.exec(t)?.[1])
    .filter((v): v is string => !!v)
    .map(Number);
}

const direct = (Card: unknown) => () =>
  renderToStaticMarkup(
    React.createElement(Card as never, { product: LONG, isRtl: false, currency: 'EGP' } as never)
  );
const viaPack = (pack: string) => () => {
  state.template = pack;
  return renderToStaticMarkup(
    React.createElement(
      StorefrontProductCard as never,
      {
        product: LONG,
        isRtl: false,
        currency: 'EGP',
      } as never
    )
  );
};
const viaCarousel = (pack: string) => () => {
  state.template = pack;
  return renderToStaticMarkup(
    React.createElement(
      ProductCarousel as never,
      {
        products: [LONG],
        isRtl: false,
        currency: 'EGP',
      } as never
    )
  );
};
const listItem = () =>
  renderToStaticMarkup(
    React.createElement(
      ProductListItem as never,
      {
        product: LONG,
        isInCompare: false,
        onToggleCompare: () => {},
        onAddToCart: () => {},
      } as never
    )
  );

const NAME_PATHS: Array<[string, () => string]> = [
  ['modern/ProductCard', direct(ModernProductCard)],
  ['elegant/ProductCard', direct(ElegantProductCard)],
  ['classic/ProductCard', direct(ClassicProductCard)],
  ['minimal/ProductCard', direct(MinimalProductCard)],
  ['bold/ProductCard', direct(BoldProductCard)],
  ...PACKS.map(p => [`Storefront card, ${p} pack`, viaPack(p)] as [string, () => string]),
  ...PACKS.map(p => [`ProductCarousel, ${p} pack`, viaCarousel(p)] as [string, () => string]),
  ['app/products/ProductListItem', listItem],
];

describe('every card render path: the product name wraps instead of leaving the card', () => {
  it.each(NAME_PATHS)('%s', (_n, renderPath) => {
    state.language = 'en';
    const name = dom(renderPath()).querySelector('[data-zone="productName"]');
    const tokens = classes(name);
    expect(tokens).toContain('[overflow-wrap:anywhere]');
    // wide letter-spacing makes ordinary words break mid-word in a 110px card
    for (const em of mobileTracking(tokens)) expect(em).toBeLessThanOrEqual(0.05);
  });
});

describe('every pack: the CTA is bounded and uses phone-sized spacing', () => {
  it.each(PACKS)('%s pack class string', pack => {
    const tokens = getPackStyles(pack).productCardCta.split(/\s+/);
    expect(tokens).toEqual(
      expect.arrayContaining(['max-w-full', 'overflow-hidden', 'text-ellipsis'])
    );
    if (tokens.some(t => /^px-/.test(t))) expect(tokens).toContain('sm:px-5');
    expect(tokens).toContain('text-xs');
    expect(tokens).toContain('sm:text-sm');
    for (const em of mobileTracking(tokens)) expect(em).toBeLessThanOrEqual(0.14);
  });

  it.each(PACKS.filter(p => p !== 'dahab'))(
    '%s: the CTA a Storefront card actually renders carries them',
    pack => {
      state.language = 'en';
      const cta = dom(viaPack(pack)()).querySelector('[data-cta="button"]');
      const tokens = classes(cta);
      expect(tokens).toContain('max-w-full');
      expect(tokens).toContain('overflow-hidden');
    }
  );

  it('minimal + elegant template cards bound their own CTA', () => {
    for (const [Card, maxEm] of [
      [MinimalProductCard, 0.14],
      [ElegantProductCard, 0.12],
    ] as const) {
      const cta = dom(direct(Card)()).querySelector('[data-zone="cta"]');
      const tokens = classes(cta);
      expect(tokens).toEqual(
        expect.arrayContaining(['max-w-full', 'overflow-hidden', 'text-ellipsis'])
      );
      for (const em of mobileTracking(tokens)) expect(em).toBeLessThanOrEqual(maxEm);
    }
  });

  it('minimal quick-add overlay is padded off the card edge', () => {
    const html = direct(MinimalProductCard)();
    expect(dom(html).querySelector('.px-3.pb-4.pt-12')).not.toBeNull();
  });
});

describe('merchant ctaSize does not undo the phone fix (tailwind-merge order)', () => {
  it.each(['sm', 'md', 'lg'] as const)('%s keeps phone padding and size', size => {
    for (const pack of PACKS) {
      const merged = cn(getPackStyles(pack).productCardCta, ctaSizeClass(size)).split(/\s+/);
      const px = merged.filter(t => /^px-[\d.]+$/.test(t));
      const text = merged.filter(t => /^text-(xs|sm|base|lg)$/.test(t));
      expect(px).toHaveLength(1);
      expect(['px-2', 'px-2.5', 'px-3']).toContain(px[0]);
      expect(['text-xs', 'text-sm']).toContain(text[0]);
      expect(merged.some(t => /^sm:px-/.test(t))).toBe(true);
    }
  });

  it('a rendered ProductCardCta with ctaSize lg is phone-capped', () => {
    const html = renderToStaticMarkup(
      React.createElement(
        ProductCardCta as never,
        {
          productId: 'p1',
          inStock: true,
          className: getPackStyles('elegant').productCardCta,
          ctaSize: 'lg',
        } as never
      )
    );
    const tokens = classes(dom(html).querySelector('[data-zone="cta"]'));
    expect(tokens).toContain('px-3');
    expect(tokens).toContain('sm:px-6');
    expect(tokens).not.toContain('px-6');
    expect(tokens).not.toContain('text-base');
  });
});

describe('PDP and cart titles wrap an unbroken name', () => {
  const tagOf = (file: string, marker: RegExp) => {
    const src = readFileSync(resolve(__dirname, '..', file), 'utf8');
    // the opening tag (attributes, any order) of the element tagged productName
    const tags = src.match(/<(?:h1|h3)\b[^>]*>/g) ?? [];
    return tags.filter(t => marker.test(t));
  };
  it.each([
    ['../app/products/[slug]/ProductDetailClient.tsx', /data-zone="productName"/],
    ['dahab/ProductDetail.tsx', /data-zone="productName"/],
    ['../app/cart/CartClient.tsx', /data-zone="productName"/],
  ])('%s: the productName heading carries the wrap rule', (file, marker) => {
    const tags = tagOf(file, marker);
    expect(tags.length).toBeGreaterThan(0);
    for (const t of tags) expect(t).toContain('[overflow-wrap:anywhere]');
  });
});

describe('ProductCardCta swaps to the icon-only button when the label would ellipsize', () => {
  const restore: Array<() => void> = [];
  afterEach(() => {
    cleanup();
    while (restore.length) restore.pop()!();
  });
  function stubMetrics(m: { scrollWidth: number; clientWidth: number; parentWidth: number }) {
    const protoScroll = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollWidth');
    const protoClient = Object.getOwnPropertyDescriptor(Element.prototype, 'clientWidth');
    Object.defineProperty(Element.prototype, 'scrollWidth', {
      configurable: true,
      get() {
        return this.tagName === 'BUTTON' ? m.scrollWidth : 0;
      },
    });
    Object.defineProperty(Element.prototype, 'clientWidth', {
      configurable: true,
      get() {
        return this.tagName === 'BUTTON' ? m.clientWidth : m.parentWidth;
      },
    });
    restore.push(() => {
      if (protoScroll) Object.defineProperty(Element.prototype, 'scrollWidth', protoScroll);
      else delete (Element.prototype as unknown as Record<string, unknown>).scrollWidth;
      if (protoClient) Object.defineProperty(Element.prototype, 'clientWidth', protoClient);
      else delete (Element.prototype as unknown as Record<string, unknown>).clientWidth;
    });
    return m;
  }
  const cta = () =>
    React.createElement(
      ProductCardCta as never,
      {
        productId: 'p1',
        inStock: true,
        labels: { addToCart: 'Add to cart' },
      } as never
    );

  it('keeps the words when they fit', async () => {
    stubMetrics({ scrollWidth: 90, clientWidth: 90, parentWidth: 120 });
    const { container } = rtlRender(cta());
    await act(async () => {});
    expect(container.querySelector('[data-cta="add-compact"]')).toBeNull();
    expect(container.textContent).toContain('Add to cart');
  });

  it('goes icon-only (keeping an accessible name) when the label overflows', async () => {
    stubMetrics({ scrollWidth: 140, clientWidth: 88, parentWidth: 88 });
    const { container } = rtlRender(cta());
    await act(async () => {});
    const btn = container.querySelector('[data-cta="add-compact"]');
    expect(btn).not.toBeNull();
    expect(btn!.getAttribute('aria-label')).toBe('Add to cart');
    expect(container.textContent).not.toContain('Add to cart');
  });

  it('never replaces a Sold Out label with a cart icon', async () => {
    stubMetrics({ scrollWidth: 140, clientWidth: 88, parentWidth: 88 });
    const { container } = rtlRender(
      React.createElement(
        ProductCardCta as never,
        {
          productId: 'p1',
          inStock: false,
          labels: { outOfStock: 'Sold Out' },
        } as never
      )
    );
    await act(async () => {});
    expect(container.querySelector('[data-cta="add-compact"]')).toBeNull();
    expect(container.textContent).toContain('Sold Out');
  });

  it('the Storefront/carousel add button (AdaptiveAddButton) does the same', async () => {
    stubMetrics({ scrollWidth: 120, clientWidth: 80, parentWidth: 80 });
    const { container } = rtlRender(
      React.createElement(AdaptiveAddButton as never, { label: 'Add to cart' } as never)
    );
    await act(async () => {});
    const btn = container.querySelector('[data-cta="add-compact"]');
    expect(btn).not.toBeNull();
    expect(btn!.getAttribute('aria-label')).toBe('Add to cart');
    expect(container.textContent).toBe('');
  });

  it('and brings the label back once the box is wide enough again', async () => {
    const m = stubMetrics({ scrollWidth: 120, clientWidth: 80, parentWidth: 80 });
    let fire: () => void = () => {};
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(cb: () => void) {
          fire = cb;
        }
        observe() {}
        disconnect() {}
      }
    );
    restore.push(() => vi.unstubAllGlobals());
    const { container } = rtlRender(
      React.createElement(AdaptiveAddButton as never, { label: 'Add to cart' } as never)
    );
    await act(async () => {});
    expect(container.querySelector('[data-cta="add-compact"]')).not.toBeNull();
    m.parentWidth = 200;
    m.scrollWidth = 100; // the full label now fits, as it would for real
    m.clientWidth = 200;
    await act(async () => fire());
    expect(container.querySelector('[data-cta="add-compact"]')).toBeNull();
    expect(container.textContent).toContain('Add to cart');
  });

  it('the compact button drops the pack/ctaSize sm: padding so the icon is centred at every width', async () => {
    stubMetrics({ scrollWidth: 120, clientWidth: 80, parentWidth: 80 });
    const { container } = rtlRender(
      React.createElement(
        AdaptiveAddButton as never,
        {
          label: 'Add to cart',
          className: getPackStyles('elegant').productCardCta,
        } as never
      )
    );
    await act(async () => {});
    const tokens = classes(container.querySelector('[data-cta="add-compact"]'));
    expect(tokens).toContain('sm:px-0');
    expect(tokens).not.toContain('sm:px-5');
    expect(tokens).toContain('px-0');
  });

  it('swaps before paint (layout effect): the first committed render is already compact', () => {
    stubMetrics({ scrollWidth: 120, clientWidth: 80, parentWidth: 80 });
    // no `await act(async)` microtask turn: a layout effect has already flushed inside render()
    const { container } = rtlRender(
      React.createElement(AdaptiveAddButton as never, { label: 'Add to cart' } as never)
    );
    expect(container.querySelector('[data-cta="add-compact"]')).not.toBeNull();
  });

  it('re-measures when a webfont finishes loading after mount', async () => {
    const m = stubMetrics({ scrollWidth: 60, clientWidth: 80, parentWidth: 80 });
    let resolveReady: () => void = () => {};
    const ready = new Promise<void>(r => (resolveReady = r));
    Object.defineProperty(document, 'fonts', {
      configurable: true,
      value: { ready, addEventListener: () => {}, removeEventListener: () => {} },
    });
    restore.push(() => delete (document as unknown as Record<string, unknown>).fonts);
    const { container } = rtlRender(
      React.createElement(AdaptiveAddButton as never, { label: 'Add to cart' } as never)
    );
    await act(async () => {});
    expect(container.querySelector('[data-cta="add-compact"]')).toBeNull(); // fits with the fallback font
    m.scrollWidth = 120; // the real font is wider
    await act(async () => resolveReady());
    expect(container.querySelector('[data-cta="add-compact"]')).not.toBeNull();
  });
});
