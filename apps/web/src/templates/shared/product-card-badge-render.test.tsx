/**
 * Renders the real product cards and asserts the custom badge's two hardest
 * promises, the ones a unit test of `resolveCardBadges` alone cannot make:
 *
 *   1. ADDITIVE CONTRACT — a product with no label produces markup that is
 *      byte-identical to the same card WITH a label once the badge chip is
 *      cut out of the latter. Nothing else on the card moves, changes class,
 *      or disappears. This is what "new visual features default OFF" means
 *      when the off switch is "the merchant hasn't typed anything".
 *
 *   2. The label actually reaches the DOM on every render path, in the right
 *      language, with the merchant's colour and corner.
 *
 * These are string comparisons of server-rendered HTML rather than DOM
 * queries because there is no jsdom / testing-library in this repo — and for
 * an additive-rendering claim, comparing the whole output string is stricter
 * than querying for the element anyway.
 */
import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { StoreLayoutSettings } from '@force/shared';

// ── Module mocks ────────────────────────────────────────────────────────────
// The cards reach the store + language through two context modules and
// nothing else, so mocking those two covers the whole tree (including
// TaxInclusiveLabel / useNumerals / ProductCardCta, which read the same two).

const storeState = {
  store: {
    id: 'store-1',
    name: 'Test Store',
    slug: 'test',
    currency: 'KWD',
    theme: {} as Record<string, unknown>,
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
    prefetch: _prefetch,
    ...rest
  }: React.PropsWithChildren<{ href: string; prefetch?: boolean }>) =>
    React.createElement('a', { href, ...rest }, children),
}));

// Imported AFTER the mocks so every card picks them up.
const { PecannbeeProductCard } = await import('./PecannbeeProductCard');
const { default: ModernProductCard } = await import('../modern/ProductCard');
const { default: ElegantProductCard } = await import('../elegant/ProductCard');
const { default: ClassicProductCard } = await import('../classic/ProductCard');
const { default: BoldProductCard } = await import('../bold/ProductCard');
const { default: MinimalProductCard } = await import('../minimal/ProductCard');
const { ProductCarousel } = await import('./ProductCarousel');
const { ProductListItem } = await import('../../app/products/ProductListItem');

// ── Fixtures ────────────────────────────────────────────────────────────────

/** Distinctive colour so the rendered chip is findable in the HTML string. */
const BADGE_COLOR = '#ff6e01';

const BASE_PRODUCT = {
  id: 'p1',
  name: "School's Offer",
  nameAr: 'عرض المدارس',
  slug: 'schools-offer',
  price: 5000,
  images: [{ id: 'i1', url: 'https://example.test/a.jpg', alt: 'a' }],
  inStock: true,
};

/** No discount — so the additive comparison is not perturbed by the mutex. */
const NO_SALE = { ...BASE_PRODUCT };
/** compareAtPrice > price → the discount badge fires. */
const ON_SALE = { ...BASE_PRODUCT, compareAtPrice: 8000 };

const LABEL = { badgeLabel: 'Offer', badgeLabelAr: 'عرض' };

const CARDS = [
  ['shared/PecannbeeProductCard', PecannbeeProductCard],
  ['modern/ProductCard', ModernProductCard],
  ['elegant/ProductCard', ElegantProductCard],
  ['classic/ProductCard', ClassicProductCard],
  ['bold/ProductCard', BoldProductCard],
  ['minimal/ProductCard', MinimalProductCard],
] as const;

function layoutWith(
  customBadge?: Record<string, unknown>,
  discountBadge?: Record<string, unknown>
) {
  return {
    productCardDefaults: { customBadge, discountBadge },
  } as unknown as StoreLayoutSettings;
}

function render(
  Card: (typeof CARDS)[number][1],
  product: Record<string, unknown>,
  { language = 'en' as 'en' | 'ar', layout = undefined as StoreLayoutSettings | undefined } = {}
): string {
  languageState.language = language;
  storeState.layout = layout;
  const isRtl = language === 'ar';
  return renderToStaticMarkup(
    React.createElement(Card as never, {
      product: product as never,
      isRtl,
      currency: 'KWD',
    })
  );
}

/**
 * Strip the custom badge chip out of a rendered card.
 *
 * The chip is the one element carrying the merchant's inline background
 * colour, so this finds it without needing a test-only attribute in
 * production markup.
 */
function stripBadgeChip(html: string): { stripped: string; chips: string[] } {
  const chipRe = new RegExp(
    `<span[^>]*style="background-color:${BADGE_COLOR}"[^>]*>[^<]*</span>`,
    'g'
  );
  const chips = html.match(chipRe) ?? [];
  return { stripped: html.replace(chipRe, ''), chips };
}

// ── 1. The additive contract ────────────────────────────────────────────────

describe('custom badge — a product with no label renders byte-identically to today', () => {
  it.each(CARDS)('%s: adding a label only ADDS a chip, changes nothing else', (_name, Card) => {
    const withoutLabel = render(Card, NO_SALE, { layout: layoutWith({ color: BADGE_COLOR }) });
    const withLabel = render(
      Card,
      { ...NO_SALE, ...LABEL },
      {
        layout: layoutWith({ color: BADGE_COLOR }),
      }
    );

    const { stripped, chips } = stripBadgeChip(withLabel);
    expect(chips).toHaveLength(1);
    expect(chips[0]).toContain('Offer');
    // The whole rest of the card — every class, every attribute, every node —
    // is identical to the no-label render.
    expect(stripped).toBe(withoutLabel);
  });

  it.each(CARDS)(
    '%s: an absent field, an explicit null and "" all render the same',
    (_name, Card) => {
      const absent = render(Card, NO_SALE);
      const explicitNull = render(Card, { ...NO_SALE, badgeLabel: null, badgeLabelAr: null });
      const empty = render(Card, { ...NO_SALE, badgeLabel: '', badgeLabelAr: '' });
      const whitespace = render(Card, { ...NO_SALE, badgeLabel: '   ', badgeLabelAr: ' ' });
      expect(explicitNull).toBe(absent);
      expect(empty).toBe(absent);
      expect(whitespace).toBe(absent);
    }
  );

  it.each(CARDS)('%s: a discounted product with no label keeps its sale badge', (_name, Card) => {
    // The mutex must be gated on there BEING a custom badge. Every existing
    // store has NULL labels, so this is the regression that would hit all of
    // them at once.
    const before = render(Card, ON_SALE);
    expect(before).toContain('-38%');
  });
});

// ── 2. The label reaches the DOM, in the right language ─────────────────────

describe('custom badge — the merchant’s label renders on every card', () => {
  it.each(CARDS)('%s: renders the English label on an English storefront', (_name, Card) => {
    expect(render(Card, { ...NO_SALE, ...LABEL })).toContain('>Offer</span>');
  });

  it.each(CARDS)('%s: renders the ARABIC label on an Arabic storefront', (_name, Card) => {
    const html = render(Card, { ...NO_SALE, ...LABEL }, { language: 'ar' });
    expect(html).toContain('>عرض</span>');
    expect(html).not.toContain('>Offer</span>');
  });

  it.each(CARDS)('%s: applies the merchant’s badge colour', (_name, Card) => {
    const html = render(
      Card,
      { ...NO_SALE, ...LABEL },
      {
        layout: layoutWith({ color: BADGE_COLOR }),
      }
    );
    expect(html).toContain(`background-color:${BADGE_COLOR}`);
  });

  it.each(CARDS)('%s: falls back to the primary token when no colour is set', (_name, Card) => {
    const html = render(Card, { ...NO_SALE, ...LABEL });
    expect(html).toContain('background-color:hsl(var(--primary))');
  });
});

// ── 3. Corner placement is physical, not mirrored ───────────────────────────

describe('custom badge — corner placement does not mirror in RTL', () => {
  it.each(CARDS.filter(([name]) => name !== 'minimal/ProductCard'))(
    '%s: bottom-left stays physically left in Arabic',
    (_name, Card) => {
      const en = render(
        Card,
        { ...NO_SALE, ...LABEL },
        {
          layout: layoutWith({ position: 'bottom-left', color: BADGE_COLOR }),
        }
      );
      const ar = render(
        Card,
        { ...NO_SALE, ...LABEL },
        {
          language: 'ar',
          layout: layoutWith({ position: 'bottom-left', color: BADGE_COLOR }),
        }
      );
      for (const html of [en, ar]) {
        const chip = stripBadgeChip(html).chips[0];
        expect(chip).toMatch(/\bleft-3\b/);
        expect(chip).not.toMatch(/\b(start|end)-3\b/);
      }
    }
  );
});

// ── 4. The collision rule, rendered ─────────────────────────────────────────

describe('custom badge — the collision rule on the real cards', () => {
  const CORNERED = CARDS.filter(([name]) => name !== 'minimal/ProductCard');

  it.each(CORNERED)(
    '%s: same corner → the custom badge wins, the sale chip goes',
    (_name, Card) => {
      const html = render(
        Card,
        { ...ON_SALE, ...LABEL },
        {
          layout: layoutWith(
            { position: 'bottom-left', color: BADGE_COLOR },
            { position: 'bottom-left' }
          ),
        }
      );
      expect(html).toContain('>Offer</span>');
      expect(html).not.toContain('-38%');
    }
  );

  it.each(CORNERED)('%s: different corners → both chips render', (_name, Card) => {
    const html = render(
      Card,
      { ...ON_SALE, ...LABEL },
      {
        layout: layoutWith(
          { position: 'top-right', color: BADGE_COLOR },
          { position: 'bottom-left' }
        ),
      }
    );
    expect(html).toContain('>Offer</span>');
    expect(html).toContain('-38%');
  });

  it.each(CARDS)('%s: out of stock → no custom badge, sale chip untouched', (_name, Card) => {
    const oos = { ...ON_SALE, ...LABEL, inStock: false };
    const html = render(Card, oos, {
      layout: layoutWith(
        { position: 'bottom-left', color: BADGE_COLOR },
        { position: 'bottom-left' }
      ),
    });
    expect(html).not.toContain('>Offer</span>');
    expect(html).toContain('-38%');
  });

  it.each(CARDS)(
    '%s: label + discount + out of stock renders exactly the no-label OOS card',
    (_name, Card) => {
      // The three-way case collapses to today's rendering, byte for byte.
      const withLabel = render(Card, { ...ON_SALE, ...LABEL, inStock: false });
      const withoutLabel = render(Card, { ...ON_SALE, inStock: false });
      expect(withLabel).toBe(withoutLabel);
    }
  );

  it('minimal: its inline discount text survives a same-corner custom badge', () => {
    // minimal's discount indicator has no corner, so the corner arm of the
    // mutex must not fire there.
    const html = render(
      MinimalProductCard,
      { ...ON_SALE, ...LABEL },
      {
        layout: layoutWith(
          { position: 'bottom-left', color: BADGE_COLOR },
          { position: 'bottom-left' }
        ),
      }
    );
    expect(html).toContain('>Offer</span>');
    expect(html).toContain('-38%');
  });
});

// ── 5. The two non-grid render paths ────────────────────────────────────────
//
// ProductCarousel and ProductListItem are the 7th and 8th product-card render
// paths. They do not share ProductCardProps with the six above (a carousel
// takes a LIST; the list item takes the API `Product` plus compare/cart
// handlers), so they get their own block rather than joining the table.

function renderCarousel(
  product: Record<string, unknown>,
  { language = 'en' as 'en' | 'ar', layout = undefined as StoreLayoutSettings | undefined } = {}
): string {
  languageState.language = language;
  storeState.layout = layout;
  return renderToStaticMarkup(
    React.createElement(ProductCarousel as never, {
      products: [product] as never,
      isRtl: language === 'ar',
      currency: 'KWD',
    })
  );
}

function renderListItem(
  product: Record<string, unknown>,
  { language = 'en' as 'en' | 'ar', layout = undefined as StoreLayoutSettings | undefined } = {}
): string {
  languageState.language = language;
  storeState.layout = layout;
  return renderToStaticMarkup(
    React.createElement(ProductListItem as never, {
      product: product as never,
      isInCompare: false,
      onToggleCompare: () => {},
      onAddToCart: () => {},
    })
  );
}

describe.each([
  ['shared/ProductCarousel', renderCarousel],
  ['app/products/ProductListItem', renderListItem],
])('custom badge — %s', (_name, renderPath) => {
  it('adding a label only ADDS a chip, changes nothing else', () => {
    const withoutLabel = renderPath(NO_SALE, { layout: layoutWith({ color: BADGE_COLOR }) });
    const withLabel = renderPath(
      { ...NO_SALE, ...LABEL },
      { layout: layoutWith({ color: BADGE_COLOR }) }
    );
    const { stripped, chips } = stripBadgeChip(withLabel);
    expect(chips).toHaveLength(1);
    expect(stripped).toBe(withoutLabel);
  });

  it('renders the English label, then the Arabic one in the Arabic locale', () => {
    expect(renderPath({ ...NO_SALE, ...LABEL })).toContain('>Offer</span>');
    const ar = renderPath({ ...NO_SALE, ...LABEL }, { language: 'ar' });
    expect(ar).toContain('>عرض</span>');
    expect(ar).not.toContain('>Offer</span>');
  });

  it('same corner → the custom badge wins and the sale chip goes', () => {
    const html = renderPath(
      { ...ON_SALE, ...LABEL },
      {
        layout: layoutWith(
          { position: 'bottom-left', color: BADGE_COLOR },
          { position: 'bottom-left' }
        ),
      }
    );
    expect(html).toContain('>Offer</span>');
    expect(html).not.toContain('-38%');
  });

  it('different corners → both chips render', () => {
    const html = renderPath(
      { ...ON_SALE, ...LABEL },
      {
        layout: layoutWith(
          { position: 'top-right', color: BADGE_COLOR },
          { position: 'bottom-left' }
        ),
      }
    );
    expect(html).toContain('>Offer</span>');
    expect(html).toContain('-38%');
  });

  it('a discounted product with NO label keeps its sale chip', () => {
    expect(renderPath(ON_SALE)).toContain('-38%');
  });
});

describe('custom badge — out of stock on the two non-grid paths', () => {
  it('ProductCarousel: suppressed, and the card equals the no-label OOS render', () => {
    const oos = { ...ON_SALE, inStock: false };
    expect(renderCarousel({ ...oos, ...LABEL })).toBe(renderCarousel(oos));
  });

  it('ProductListItem: suppressed, and the row equals the no-label OOS render', () => {
    // ProductListItem derives `orderable` from `inventory`, not `inStock`.
    const oos = { ...ON_SALE, inventory: 0 };
    expect(renderListItem({ ...oos, ...LABEL })).toBe(renderListItem(oos));
  });
});
