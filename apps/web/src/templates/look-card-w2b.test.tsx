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
import { render, cleanup, fireEvent } from '@testing-library/react';
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
const { StorefrontProductCard } = await import('./shared/StorefrontProductCard');
const { default: BaseProductCard } = await import('./base/ProductCard');
const SKIN_CARDS = {};
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
  state.template = 'qamar';
  // The "New" chip is a merchant switch, off by default (Ruling D1016-NEW-1): these cases test the
  // chip's geometry and tone, so the switch is on.
  state.theme = {
    ...composeStoreTheme({ template: state.template as never, look, theme: {} }),
    showNewBadge: true,
  } as StoreTheme;
}

const PATHS: Array<[string, (k: Kind) => React.ReactElement]> = [
  [
    'StorefrontProductCard',
    k =>
      React.createElement(
        StorefrontProductCard as never,
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
    'base/ProductCard',
    k =>
      React.createElement(
        BaseProductCard as never,
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
      if (name !== 'base/ProductCard') expect(add[0].className, look).toContain('border-input');
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

describe('StorefrontProductCard material (L-12, LB-02, M-03, K-01)', () => {
  const card = (k: Kind) =>
    render(
      React.createElement(
        StorefrontProductCard as never,
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
    expect(h).toContain('bg-white');
    expect(h).not.toContain('bg-white/');
    expect(h).toContain('rgb(20_20_20');
  });
  it('Atelier: a bare glyph (no disc, no blur), no hover lift, the accent chip on the radius', () => {
    selectLook('qamar.atelier');
    const c = card('sale');
    const h = heart(c).className;
    // a11y P1-8 (W4): a bare glyph measured 2.38:1 on dark photos; it now sits on a plate in the
    // look's own (square) radius: no disc, no blur, no shadow.
    expect(h).not.toContain('rounded-full');
    expect(h).toContain('rounded-[var(--radius)]');
    expect(h).toContain('bg-white');
    expect(h).not.toContain('bg-white/'); // opaque plate: no grey square over a photo (audit #9)
    expect(h).not.toContain('backdrop-blur');
    expect(h).not.toMatch(/shadow-/);
    expect(c.querySelector('article')!.className).not.toContain('md:hover:scale');
    const chip = Array.from(c.querySelectorAll('span')).find(s => /%/.test(s.textContent ?? ''))!;
    expect(chip.className).toContain('rounded-[var(--radius)]');
    expect(chip.className).not.toContain('shadow');
    // the chip reads --chip-bg and falls back to the accent pair (a look re-derives it, B2-26)
    expect(chip.getAttribute('style')).toContain('var(--chip-bg, var(--accent))');
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
  it('the bare heart on its plate is >= 3:1 even over a black photo (P1-8)', () => {
    const plateOverBlack = blend('#ffffff', 0.85, '#000000');
    expect(
      contrastRatio(plateOverBlack, blend(OVER_PHOTO_INK, 0.78, plateOverBlack))
    ).toBeGreaterThanOrEqual(3);
  });
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
describe('StorefrontProductCard NEW chip never shares the heart corner', () => {
  const newOne = (sale: boolean) =>
    ({ ...product(sale ? 'sale' : 'plain'), isNew: true }) as ReturnType<typeof product>;
  const chipOf = (c: HTMLElement) => c.querySelector('[data-badge="new"]') as HTMLElement;
  it.each([null, 'qamar.atelier', 'qamar.lookbook'])('%s', look => {
    selectLook(look);
    for (const sale of [false, true]) {
      const { container } = render(
        React.createElement(
          StorefrontProductCard as never,
          {
            product: newOne(sale),
            isRtl: true,
            pack: state.template,
          } as never
        )
      );
      const cls = chipOf(container).className;
      expect(cls, `sale=${sale}`).not.toMatch(/\btop-3 start-3\b|\bstart-3 top-3\b/);
      // IA-08 (W4): one fixed corner, top-end; with a sale chip it stacks under it, never jumps.
      expect(cls, `sale=${sale}`).toContain('end-3');
      expect(cls, `sale=${sale}`).toContain(sale ? 'top-12' : 'top-3');
      expect(cls, `sale=${sale}`).not.toContain('bottom-3');
      cleanup();
    }
  });
});

describe('base/ProductCard chips (the Qamar search grid) follow cardBadge', () => {
  const card = () =>
    render(
      React.createElement(
        BaseProductCard as never,
        {
          product: { ...product('plain'), isNew: true },
          isRtl: true,
        } as never
      )
    ).container.querySelector('[data-badge="new"]') as HTMLElement;
  it('no look: the quiet tracked primary text chip, unchanged', () => {
    selectLook(null);
    expect(card().className).toContain('tracking-[0.18em]');
  });
  it('a look store: the chip on the radius, neutral ink on paper (VT-b supersedes the accent NEW chip)', () => {
    selectLook('qamar.lookbook');
    const c = card();
    expect(c.className).toContain('rounded-[var(--radius)]');
    expect(c.getAttribute('style')).toContain('hsl(var(--background))');
    expect(c.getAttribute('style')).not.toContain('--accent');
  });
});

// R-12 (W3): the card's photo link is its one tab stop to the product page; the name repeats it
// for the pointer only, and a visible "View" names the product it opens.
describe('StorefrontProductCard keyboard stops (R-12)', () => {
  it.each([null, 'qamar.atelier'])('%s', look => {
    selectLook(look);
    const c = render(
      React.createElement(
        StorefrontProductCard as never,
        {
          product: product('sized'),
          isRtl: true,
          pack: state.template,
        } as never
      )
    ).container;
    const href = '/products/product-sized';
    const stops = [...c.querySelectorAll<HTMLAnchorElement>(`a[href="${href}"]`)].filter(
      a => a.tabIndex !== -1
    );
    const view = stops.find(a => a.getAttribute('data-cta'));
    // photo link (+ the visible View when the look keeps one), never the name a second time
    expect(stops.length).toBe(view ? 2 : 1);
    if (view) expect(view.getAttribute('aria-label')).toBe('عرض منتج sized');
  });
});

// T-03 + decision (a) (W3): a look's display face (Cormorant, Playfair, Archivo) is set at >= 24px;
// the related-products strip heading was 20px on every store. A store with no look keeps 20px.
describe('relatedHeadingSize', () => {
  it('24px on a look store, 20px without a look; both related strips use it', async () => {
    const { relatedHeadingSize } = await import('./shared/look-card');
    expect(relatedHeadingSize('qamar.atelier')).toBe('24px');
    expect(relatedHeadingSize(null)).toBe('20px');
    const fs = await import('node:fs');
    const p = await import('node:path');
    for (const f of [
      '../components/YouMightAlsoLike.tsx',
      '../app/products/[slug]/ProductDetailClient.tsx',
    ])
      expect(fs.readFileSync(p.resolve(__dirname, f), 'utf8'), f).toContain(
        'relatedHeadingSize(store.look)'
      );
  });
});

// IA-05 (independent audit P1): at 1280 the 200px-capped, centred cards floated in ~300px columns,
// 45px in from the section heading and out of line with the carousels on the same page. On a look
// store (photo-led, the look owns the ratio) the card fills its grid column, so the first card
// starts at the heading's edge. A store with no look keeps the compact cap.
describe('StorefrontProductCard fills its column on a look store (IA-05)', () => {
  const article = () =>
    render(
      React.createElement(
        StorefrontProductCard as never,
        {
          product: product('plain'),
          isRtl: true,
          pack: state.template,
        } as never
      )
    ).container.querySelector('article')!.className;
  it('look store: no width cap, no auto margins', () => {
    selectLook('qamar.lookbook');
    const c = article();
    expect(c).not.toMatch(/max-w-\[/);
    expect(c).not.toContain('mx-auto');
  });
  it('no look: the compact cap and centring stay', () => {
    selectLook(null);
    const c = article();
    expect(c).toContain('md:max-w-[200px]');
    expect(c).toContain('mx-auto');
  });
});

describe('base/ProductCard fills its column on a look store too (IA-05, search grid)', () => {
  const root = () =>
    render(
      React.createElement(
        BaseProductCard as never,
        { product: product('plain'), isRtl: true } as never
      )
    ).container.firstElementChild as HTMLElement;
  it('look store: no cap, no auto margins; no look: unchanged', () => {
    selectLook('qamar.vitrine');
    expect(root().className).not.toMatch(/max-w-\[|mx-auto/);
    cleanup();
    selectLook(null);
    expect(root().className).toContain('mx-auto');
  });
});

// a11y P1-6 / rule (e) (W4): Atelier's product carousel auto-advanced every 4s and paused only on
// hover/touch: a keyboard user's focus scrolled away under them, and nothing could stop it.
describe('ProductCarousel autoplay (rule e)', () => {
  const mount = () =>
    render(
      React.createElement(
        ProductCarousel as never,
        {
          products: [product('plain'), product('sale'), product('sized')],
          isRtl: true,
          pack: state.template,
        } as never
      )
    ).container;
  it('pauses while focus is inside, and has a visible pause toggle', () => {
    selectLook('qamar.atelier');
    const c = mount();
    const strip = c.querySelector('[data-autoplay]') as HTMLElement;
    expect(strip.getAttribute('data-autoplay')).toBe('running');
    const toggle = c.querySelector('button[data-autoplay-toggle]') as HTMLButtonElement;
    expect(toggle).toBeTruthy();
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    const firstLink = strip.querySelector('a') as HTMLElement;
    fireEvent.focus(firstLink);
    expect(strip.getAttribute('data-autoplay')).toBe('paused');
    fireEvent.blur(firstLink);
    expect(strip.getAttribute('data-autoplay')).toBe('running');
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    expect(strip.getAttribute('data-autoplay')).toBe('paused');
  });
});

// IA-08 part 2 (W4): grid cards had a heart and a semibold title, carousel cards neither: two card
// dialects on one page. On a look store the carousel renders the SAME shared card as the grid.
describe('one card anatomy on a look store: grid and carousel', () => {
  it('the carousel item is the shared card (heart, name slot, chips) on a look', () => {
    selectLook('qamar.lookbook');
    const c = render(
      React.createElement(
        ProductCarousel as never,
        {
          products: [product('sale')],
          isRtl: true,
          pack: state.template,
        } as never
      )
    ).container;
    const li = c.querySelector('li')!;
    expect(li.querySelector('article[itemtype="https://schema.org/Product"]')).toBeTruthy();
    expect(li.querySelector('button[aria-pressed]')).toBeTruthy();
    const labelled = li.querySelector('article')!.getAttribute('aria-labelledby')!;
    expect(labelled).toMatch(/^prod-.+-name$/);
    expect(li.querySelector(`[id="${labelled}"]`)).toBeTruthy();
  });
  it('the same product twice on one page gets two distinct name ids (STOP-2 P2-1)', () => {
    selectLook('qamar.lookbook');
    const el = () =>
      React.createElement(
        ProductCarousel as never,
        { products: [product('sale')], isRtl: true, pack: state.template } as never
      );
    const { container } = render(React.createElement('div', null, el(), el()));
    const ids = [...container.querySelectorAll('article')].map(a =>
      a.getAttribute('aria-labelledby')
    );
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });
  it('no look: the carousel keeps its own card (no heart)', () => {
    selectLook(null);
    const c = render(
      React.createElement(
        ProductCarousel as never,
        {
          products: [product('sale')],
          isRtl: true,
          pack: 'base',
        } as never
      )
    ).container;
    expect(c.querySelector('li button[aria-pressed]')).toBeNull();
  });
});

// LB-c (independent audit): on Lookbook the collage and look cards were rounded, product
// images square, chips pills and the heart a 40px white disc: four shape idioms at once.
// On a look store the product image, the heart and the chips all take the look's radius.
describe('one radius per look (LB-c)', () => {
  const card = (C: unknown) =>
    render(
      React.createElement(
        C as never,
        { product: product('sale'), isRtl: true, pack: state.template } as never
      )
    ).container;
  it.each(['qamar.atelier', 'qamar.lookbook', 'qamar.vitrine'])(
    '%s: card image and heart use var(--radius); no pill, no disc',
    look => {
      selectLook(look);
      for (const C of [StorefrontProductCard, BaseProductCard]) {
        const c = card(C);
        const img = c.querySelector('img')!.closest('div')!;
        expect(img.className).toContain('rounded-[var(--radius)]');
        const heart = c.querySelector('button[aria-pressed]') as HTMLElement | null;
        if (heart) expect(heart.className).not.toMatch(/\brounded-full\b/);
        cleanup();
      }
    }
  );
  it('no look: the card image keeps the skin shape', () => {
    selectLook(null);
    const img = card(StorefrontProductCard).querySelector('img')!.closest('div')!;
    expect(img.className).not.toContain('rounded-[var(--radius)]');
  });
});

// VT-b (independent audit): on Vitrine the teal CTA, rose chips, gold rules and three
// saturated occasion tiles came close to the too-many-colours anti-reference. The NEW chip
// is neutral (ink on paper) on every look, so the accent belongs to the sale chip only.
describe('the NEW chip is neutral on a look store (VT-b)', () => {
  it.each(['qamar.atelier', 'qamar.lookbook', 'qamar.vitrine'])('%s', look => {
    selectLook(look);
    for (const C of [StorefrontProductCard, BaseProductCard]) {
      const c = render(
        React.createElement(
          C as never,
          {
            product: { ...product('plain'), isNew: true },
            isRtl: true,
            pack: state.template,
          } as never
        )
      ).container;
      const chip = c.querySelector('[data-badge="new"]') as HTMLElement;
      expect(chip).toBeTruthy();
      // jsdom drops a var() colour from style.backgroundColor, so read the raw attribute.
      const style = chip.getAttribute('style') ?? '';
      expect(style).toMatch(/background-color:\s*hsl\(var\(--background\)\)/);
      expect(style).toMatch(/(^|;)\s*color:\s*hsl\(var\(--foreground\)\)/);
      expect(style).not.toContain('--accent');
      cleanup();
    }
  });
});

// a11y re-audit P2-N4 (rule (d)): the card name link measured 144-157 x 40 (hit 41).
describe('the card name link is a 44px pointer target (P2-N4)', () => {
  it('a block link with a 44px floor', () => {
    selectLook('qamar.atelier');
    const c = render(
      React.createElement(
        StorefrontProductCard as never,
        { product: product('plain'), isRtl: true, pack: state.template } as never
      )
    ).container;
    const name = c.querySelector('a[tabindex="-1"]') as HTMLElement;
    expect(name.className).toMatch(/\bblock\b/);
    expect(name.className).toMatch(/\bmin-h-11\b/);
  });
});

// Taste re-audit P2-8: on Atelier at 1280 the carousel showed 5 cards ending at ~1175px, a ragged
// edge under a 4-column grid. On a look store the carousel card is one grid column wide from lg
// (25% less the row gap's share), so both rows share column edges.
describe('look carousel columns match the grid (P2-8)', () => {
  it.each([
    [undefined, 'lg:w-[calc(25%-12px)]'],
    ['tight', 'lg:w-[calc(25%-9px)]'],
    ['loose', 'lg:w-[calc(25%-18px)]'],
  ])('cardGap %s', (cardGap, cls) => {
    selectLook('qamar.atelier');
    const c = render(
      React.createElement(
        ProductCarousel as never,
        { products: [product('plain')], isRtl: true, pack: state.template, cardGap } as never
      )
    ).container;
    expect(c.querySelector('li')!.className).toContain(cls);
  });
});
