// @vitest-environment jsdom
/**
 * W2b (Qamar taste gate): the look's card tokens reach every card path, and a store with no look
 * renders its cards exactly as before.
 *
 * - L-01 `cardCta`: Atelier `none` (no control: the card is the link), Lookbook/Vitrine `quiet`
 *   (an outline add only for a simple in-stock product; never a navigate-only "View" slab, so a
 *   row never mixes "عرض" and "إضافة للسلة"). A merchant `ctaMode` beats the look.
 * - M-03 `cardHover: none`: no scale / shadow lift.
 * - K-01 `cardBadge: accent`: chips on the look's accent pair and radius, no glow, >= 4.5:1.
 * - L-12 / LB-02 heart: never reads the page foreground on a look (1.12:1 on Lookbook before).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { render, cleanup } from '@testing-library/react';
import {
  composeStoreTheme,
  contrastRatio,
  LOOKS,
  type StoreTheme,
  type StoreLayoutSettings,
} from '@ebda/shared';

const state: {
  template: string;
  look: string | null;
  theme: StoreTheme | Record<string, never>;
  layout: StoreLayoutSettings | undefined;
} = { template: 'qamar', look: null, theme: {}, layout: undefined };

window.matchMedia ??= ((query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addListener: () => {},
  removeListener: () => {},
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => false,
})) as typeof window.matchMedia;

vi.mock('../contexts/StoreContext', () => ({
  useStore: () => ({
    store: {
      id: 's1',
      name: 'S',
      slug: 's',
      currency: 'EGP',
      theme: state.theme,
      look: state.look,
    },
    layout: state.layout,
  }),
  useStoreUrl: () => (p: string) => p,
  useStoreTemplate: () => state.template,
}));
vi.mock('../contexts/LanguageContext', () => ({
  useLanguage: () => ({
    language: 'ar',
    isRtl: true,
    t: (en: string, ar?: string) => ar ?? en,
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
  default: ({ href, children, ...rest }: React.PropsWithChildren<{ href: string }>) =>
    React.createElement('a', { href, ...rest }, children),
}));

const adapters = await import('./adapters');
const { PecannbeeProductCard } = await import('./shared/PecannbeeProductCard');
const { default: MinimalProductCard } = await import('./minimal/ProductCard');
const SKIN_CARDS = {
  modern: (await import('./modern/ProductCard')).default,
  elegant: (await import('./elegant/ProductCard')).default,
  classic: (await import('./classic/ProductCard')).default,
  bold: (await import('./bold/ProductCard')).default,
};
const { ProductCarousel } = await import('./shared/ProductCarousel');
const { ProductListItem } = await import('../app/products/ProductListItem');
const { lookCardCta, lookCtaVisible, overPhotoMaterial, OVER_PHOTO_INK } =
  await import('./shared/look-card');

type Kind = 'sized' | 'plain' | 'soldOut' | 'sale';
const product = (k: Kind) =>
  adapters.toTemplateProduct({
    id: `p-${k}`,
    name: `Product ${k}`,
    nameAr: `منتج ${k}`,
    slug: `product-${k}`,
    price: 5000,
    compareAtPrice: k === 'sale' ? 8000 : undefined,
    status: 'active',
    inStock: k !== 'soldOut',
    acceptsBackorder: false,
    inventory: k === 'soldOut' ? 0 : 5,
    images: [{ id: 'i1', url: 'https://example.test/a.jpg', alt: 'a' }],
    variants:
      k === 'sized'
        ? [{ id: 'v1', price: 5000, inventory: 7, options: { Size: 'M' }, acceptsBackorder: false }]
        : [],
  } as never);

function selectLook(look: string | null) {
  state.look = look;
  state.template = look ? 'qamar' : 'minimal';
  state.theme = composeStoreTheme({ template: state.template as never, look, theme: {} });
}

const PATHS: Array<[string, (k: Kind) => React.ReactElement]> = [
  [
    'PecannbeeProductCard',
    k =>
      React.createElement(
        PecannbeeProductCard as never,
        {
          product: product(k),
          isRtl: true,
          pack: state.template,
          onAddToCart: () => {},
        } as never
      ),
  ],
  [
    'ProductCarousel',
    k =>
      React.createElement(
        ProductCarousel as never,
        {
          products: [product(k)],
          isRtl: true,
          pack: state.template,
          onAddToCart: () => {},
        } as never
      ),
  ],
  [
    'minimal/ProductCard',
    k =>
      React.createElement(
        MinimalProductCard as never,
        {
          product: product(k),
          isRtl: true,
          onAddToCart: () => {},
        } as never
      ),
  ],
  ...Object.entries(SKIN_CARDS).map(([skin, Card]): [string, (k: Kind) => React.ReactElement] => [
    `${skin}/ProductCard`,
    k =>
      React.createElement(
        Card as never,
        {
          product: product(k),
          isRtl: true,
          onAddToCart: () => {},
        } as never
      ),
  ]),
  [
    'ProductListItem',
    k =>
      React.createElement(
        ProductListItem as never,
        {
          product: product(k),
          isInCompare: false,
          onToggleCompare: () => {},
          onAddToCart: () => {},
        } as never
      ),
  ],
];

/** Every purchase / navigate control in a rendered card (heart and compare excluded). */
function ctas(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>('button, a, span')).filter(el => {
    // Visible text only: the photo's sold-out ribbon is aria-hidden (a label, X-01).
    const copy = el.cloneNode(true) as HTMLElement;
    copy.querySelectorAll('[aria-hidden="true"]').forEach(n => n.remove());
    const text = (copy.textContent ?? '').trim();
    if (el.querySelector('button, a')) return false;
    if (el.tagName === 'SPAN' && el.parentElement?.closest('button')) return false;
    // The sold-out ribbon on the photo is a label, not a control (aria-hidden, X-01).
    if (el.closest('[aria-hidden="true"], [aria-hidden=""]')) return false;
    const label = `${el.getAttribute('aria-label') ?? ''} ${text}`;
    if (/wish|مفضل|compare|قارن|previous|next|السابق|التالي/i.test(label)) return false;
    return /^(عرض|إضافة للسلة|أضف للسلة|أضف إلى السلة|نفدت الكمية|نفذت الكمية|View|Add to Cart|Out of Stock)$/i.test(
      text
    );
  });
}

afterEach(() => {
  cleanup();
  state.layout = undefined;
});

describe('lookCardCta / lookCtaVisible', () => {
  it('merchant ctaMode beats the look token (merchant > look > skin)', () => {
    expect(lookCardCta({ cardCta: 'none' }, undefined)).toBe('none');
    expect(lookCardCta({ cardCta: 'none' }, { productCardDefaults: { ctaMode: 'auto' } })).toBe(
      undefined
    );
    expect(lookCardCta({}, undefined)).toBeUndefined();
  });
  it('none hides every control; quiet shows only a simple buyable add; legacy shows all', () => {
    const m = (hasVariants: boolean, orderable: boolean) => ({ hasVariants, orderable });
    expect(lookCtaVisible('none', m(false, true))).toBe(false);
    expect(lookCtaVisible('quiet', m(false, true))).toBe(true);
    expect(lookCtaVisible('quiet', m(true, true))).toBe(false);
    expect(lookCtaVisible('quiet', m(false, false))).toBe(false);
    expect(lookCtaVisible(undefined, m(true, false))).toBe(true);
  });
});

describe.each(PATHS)('%s', (name, path) => {
  it('Atelier (cardCta none): no control on a sized, a simple or a sold-out product', () => {
    selectLook('qamar.atelier');
    for (const k of ['sized', 'plain', 'soldOut'] as const) {
      const { container } = render(path(k));
      expect(
        ctas(container).map(e => e.textContent),
        k
      ).toEqual([]);
      cleanup();
    }
  });
  it('Lookbook / Vitrine (quiet): a sized product has no "View"; a simple one gets the outline add', () => {
    for (const look of ['qamar.lookbook', 'qamar.vitrine']) {
      selectLook(look);
      const sized = render(path('sized'));
      expect(
        ctas(sized.container).map(e => e.textContent),
        look
      ).toEqual([]);
      cleanup();
      const plain = render(path('plain'));
      const add = ctas(plain.container);
      expect(add.length, look).toBe(1);
      // The minimal skin's add is already its own quiet underlined text link (no slab).
      if (name !== 'minimal/ProductCard') expect(add[0].className, look).toContain('border-input');
      expect(add[0].className, look).not.toContain('bg-primary');
      cleanup();
      const out = render(path('soldOut'));
      expect(
        ctas(out.container).map(e => e.textContent),
        look
      ).toEqual([]);
      cleanup();
    }
  });
  it('a merchant ctaMode keeps the legacy control on a look store', () => {
    selectLook('qamar.atelier');
    state.layout = { productCardDefaults: { ctaMode: 'auto' } } as never;
    const { container } = render(path('sized'));
    expect(ctas(container).length).toBeGreaterThan(0);
  });
  it('no look: the legacy control is still there (sized shows its View)', () => {
    selectLook(null);
    const { container } = render(path('sized'));
    expect(ctas(container).length).toBeGreaterThan(0);
  });
});

describe('PecannbeeProductCard material (L-12, LB-02, M-03, K-01)', () => {
  const card = (k: Kind) =>
    render(
      React.createElement(
        PecannbeeProductCard as never,
        {
          product: product(k),
          isRtl: true,
          pack: state.template,
        } as never
      )
    ).container;
  const heart = (c: HTMLElement) => c.querySelector('button[aria-pressed]') as HTMLElement;

  it('no look: heart, hover and chip classes are the legacy ones', () => {
    selectLook(null);
    const c = card('sale');
    expect(heart(c).className).toContain('text-foreground/70');
    expect(heart(c).className).toContain('backdrop-blur-sm');
    expect(c.querySelector('article')!.className).toContain('md:hover:scale-[1.02]');
    const chip = Array.from(c.querySelectorAll('span')).find(s => /%/.test(s.textContent ?? ''))!;
    expect(chip.className).toContain('rounded-full');
  });
  it('Lookbook: the heart icon never reads the page foreground (fixed ink on the white disc)', () => {
    selectLook('qamar.lookbook');
    const h = heart(card('plain')).className;
    expect(h).not.toContain('text-foreground');
    expect(h).toContain('bg-white/95');
    expect(h).toContain('rgb(20_20_20');
  });
  it('Atelier: a bare glyph (no disc, no blur), no hover lift, the accent chip on the radius', () => {
    selectLook('qamar.atelier');
    const c = card('sale');
    const h = heart(c).className;
    expect(h).not.toContain('rounded-full');
    expect(h).not.toContain('bg-white');
    expect(h).not.toContain('backdrop-blur');
    expect(h).toContain('h-11 w-11');
    expect(c.querySelector('article')!.className).not.toContain('md:hover:scale');
    const chip = Array.from(c.querySelectorAll('span')).find(s => /%/.test(s.textContent ?? ''))!;
    expect(chip.className).toContain('rounded-[var(--radius)]');
    expect(chip.className).not.toContain('shadow');
    expect(chip.getAttribute('style')).toContain('hsl(var(--accent))');
  });
});

describe('contrast on every look', () => {
  const blend = (fg: string, a: number, bg = '#ffffff') => {
    const p = (h: string, i: number) => parseInt(h.slice(1 + i * 2, 3 + i * 2), 16);
    return (
      '#' +
      [0, 1, 2]
        .map(i =>
          Math.round(p(fg, i) * a + p(bg, i) * (1 - a))
            .toString(16)
            .padStart(2, '0')
        )
        .join('')
    );
  };
  it.each(LOOKS.map(l => [l.id, l] as const))(
    '%s: the heart icon on its white disc / white photo is >= 3:1 (1.4.11)',
    (_id, l) => {
      const theme = composeStoreTheme({ template: l.skin, look: l.id, theme: {} });
      expect(overPhotoMaterial(theme, l.id)).toBeDefined();
      expect(contrastRatio('#ffffff', blend(OVER_PHOTO_INK, 0.78))).toBeGreaterThanOrEqual(3);
    }
  );
  it.each(LOOKS.filter(l => l.tokens.cardBadge === 'accent').map(l => [l.id, l] as const))(
    '%s: the accent chip pair is >= 4.5:1',
    (_id, l) => {
      expect(
        contrastRatio(l.tokens.accent, l.tokens.onAccent ?? l.tokens.onPrimary)
      ).toBeGreaterThanOrEqual(4.5);
    }
  );
});

// X-01 class (W2b, live 390 shots): the NEW chip had its own hard-coded top-start corner, the
// same corner as this card's wishlist heart, on every store. It now takes its corner from the
// card's allocator: top-start is the heart's, so top-end, or bottom-start when the sale chip
// holds top-end.
describe('PecannbeeProductCard NEW chip never shares the heart corner', () => {
  const newOne = (sale: boolean) =>
    ({ ...product(sale ? 'sale' : 'plain'), isNew: true }) as ReturnType<typeof product>;
  const chipOf = (c: HTMLElement) =>
    c.querySelector('[aria-label="منتج جديد"], [aria-label="New product"]') as HTMLElement;
  it.each([null, 'qamar.atelier', 'qamar.lookbook'])('%s', look => {
    selectLook(look);
    for (const sale of [false, true]) {
      const { container } = render(
        React.createElement(
          PecannbeeProductCard as never,
          {
            product: newOne(sale),
            isRtl: true,
            pack: state.template,
          } as never
        )
      );
      const cls = chipOf(container).className;
      expect(cls, `sale=${sale}`).not.toMatch(/\btop-3 start-3\b|\bstart-3 top-3\b/);
      expect(cls, `sale=${sale}`).toContain(sale ? 'bottom-3' : 'end-3');
      cleanup();
    }
  });
});

describe('minimal/ProductCard chips (the Qamar search grid) follow cardBadge', () => {
  const card = () =>
    render(
      React.createElement(
        MinimalProductCard as never,
        {
          product: { ...product('plain'), isNew: true },
          isRtl: true,
        } as never
      )
    ).container.querySelector('[aria-label="منتج جديد"]') as HTMLElement;
  it('no look: the quiet tracked primary text chip, unchanged', () => {
    selectLook(null);
    expect(card().className).toContain('tracking-[0.18em]');
  });
  it('a look with cardBadge accent: the accent chip on the radius', () => {
    selectLook('qamar.lookbook');
    const c = card();
    expect(c.className).toContain('rounded-[var(--radius)]');
    expect(c.getAttribute('style')).toContain('hsl(var(--accent))');
  });
});
