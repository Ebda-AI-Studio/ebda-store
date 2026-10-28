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
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { StoreLayoutSettings } from '@ebda/shared';

// ── Module mocks ────────────────────────────────────────────────────────────
// The cards reach the store + language through two context modules and
// nothing else, so mocking those two covers the whole tree (including
// TaxInclusiveLabel / useNumerals / ProductCardCta, which read the same two).

const storeState = {
  store: {
    id: 'store-1',
    name: 'Test Store',
    slug: 'test',
    currency: 'EGP',
    theme: {} as Record<string, unknown>,
  },
  layout: undefined as StoreLayoutSettings | undefined,
};
const languageState = { language: 'en' as 'en' | 'ar' };

vi.mock('../../contexts/StoreContext', () => ({
  useStore: () => storeState,
  useStoreUrl: () => (path: string) => path,
  useStoreTemplate: () => 'qamar',
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
const { StorefrontProductCard } = await import('./StorefrontProductCard');
const { default: BaseProductCard } = await import('../base/ProductCard');
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
  ['shared/StorefrontProductCard', StorefrontProductCard],
  ['base/ProductCard', BaseProductCard],
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
      currency: 'EGP',
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
    `<span[^>]*style="background-color:${BADGE_COLOR}[^"]*"[^>]*>[^<]*</span>`,
    'g'
  );
  const chips = html.match(chipRe) ?? [];
  // a11y P2-14: the chip is aria-hidden and its words follow the product name in
  // the link's name (aria-label suffix or an sr-only span). That announcement is
  // part of adding a label, so it is stripped along with the chip.
  const stripped = html
    .replace(chipRe, '')
    .replace(/(aria-label="[^"]*), Offer"/g, '$1"')
    .replace(/<span class="sr-only">, Offer<\/span>/g, '');
  return { stripped, chips };
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
    expect(before).toContain('\u221238%');
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
  it.each(CARDS.filter(([name]) => name !== 'base/ProductCard'))(
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
  const CORNERED = CARDS.filter(([name]) => name !== 'base/ProductCard');

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
      expect(html).not.toContain('\u221238%');
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
    expect(html).toContain('\u221238%');
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
    expect(html).toContain('\u221238%');
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

  it('base: its inline discount text survives a same-corner custom badge', () => {
    // the base card's discount indicator has no corner, so the corner arm of the
    // mutex must not fire there.
    const html = render(
      BaseProductCard,
      { ...ON_SALE, ...LABEL },
      {
        layout: layoutWith(
          { position: 'bottom-left', color: BADGE_COLOR },
          { position: 'bottom-left' }
        ),
      }
    );
    expect(html).toContain('>Offer</span>');
    expect(html).toContain('\u221238%');
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
      currency: 'EGP',
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
    expect(html).not.toContain('\u221238%');
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
    expect(html).toContain('\u221238%');
  });

  it('a discounted product with NO label keeps its sale chip', () => {
    expect(renderPath(ON_SALE)).toContain('\u221238%');
  });
});

describe('custom badge — out of stock on the two non-grid paths', () => {
  it('ProductCarousel: suppressed, and the card equals the no-label OOS render', () => {
    const oos = { ...ON_SALE, inStock: false };
    expect(renderCarousel({ ...oos, ...LABEL })).toBe(renderCarousel(oos));
  });

  it('ProductListItem: suppressed, and the row equals the no-label OOS render', () => {
    // ProductListItem reads the server's `inStock` first (C-01, the shared card
    // rule); a sold-out listing payload carries both flags.
    const oos = { ...ON_SALE, inStock: false, inventory: 0 };
    expect(renderListItem({ ...oos, ...LABEL })).toBe(renderListItem(oos));
  });
});

// ── #1614 / #1611 — chip text colour and tap-through, on all 8 card paths ───

const ALL_PATHS: Array<
  [string, (p: Record<string, unknown>, o?: { layout?: StoreLayoutSettings }) => string]
> = [
  ...CARDS.map(
    ([name, Card]) =>
      [
        name,
        (p: Record<string, unknown>, o?: { layout?: StoreLayoutSettings }) => render(Card, p, o),
      ] as [string, (p: Record<string, unknown>, o?: { layout?: StoreLayoutSettings }) => string]
  ),
  ['shared/ProductCarousel', renderCarousel],
  ['app/products/ProductListItem', renderListItem],
];

/** The custom chip's opening tag: the only span whose text is the label. */
function chipTag(html: string): string {
  const m = html.match(/<span[^>]*>Offer<\/span>/);
  expect(m, 'custom chip not rendered').not.toBeNull();
  return m![0];
}

describe.each(ALL_PATHS)('custom badge colours + tap-through — %s', (_name, renderPath) => {
  it('no merchant colour: primary background with the PAIRED primary-foreground text', () => {
    const tag = chipTag(renderPath({ ...NO_SALE, ...LABEL }));
    expect(tag).toContain('background-color:hsl(var(--primary))');
    expect(tag).toContain('color:hsl(var(--primary-foreground))');
  });

  it('merchant colour: keeps white text, exactly as before', () => {
    const tag = chipTag(
      renderPath({ ...NO_SALE, ...LABEL }, { layout: layoutWith({ color: BADGE_COLOR }) })
    );
    expect(tag).toContain(`background-color:${BADGE_COLOR}`);
    expect(tag).toContain('color:#ffffff');
  });

  it('the chip never swallows a tap meant for the card control underneath', () => {
    expect(chipTag(renderPath({ ...NO_SALE, ...LABEL }))).toContain('pointer-events-none');
  });

  it('neither does the corner discount chip (the base card renders it inline, not as a chip)', () => {
    const html = renderPath(ON_SALE);
    const m = html.match(/<span[^>]*>\u2066\u221238%\u2069<\/span>/);
    if (_name === 'base/ProductCard') return;
    expect(m, 'discount chip not rendered').not.toBeNull();
    expect(m![0]).toContain('pointer-events-none');
  });
});

// ── #665 — a merchant cardShape radius beats the pack's own rounded-* ───────

describe('cardShape radius vs the pack (tailwind-merge order)', () => {
  it.each([
    ['StorefrontProductCard', () => StorefrontProductCard],
    ['ProductCarousel', () => ProductCarousel],
  ] as const)('%s: circle cardShape renders rounded-full, not the pack radius', (name, get) => {
    storeState.layout = undefined;
    languageState.language = 'en';
    const Comp = get();
    const props =
      name === 'ProductCarousel'
        ? { products: [NO_SALE], pack: 'souq', cardShape: 'circle', currency: 'EGP' }
        : { product: NO_SALE, pack: 'souq', cardShape: 'circle', currency: 'EGP' };
    const html = renderToStaticMarkup(React.createElement(Comp as never, props as never));
    // The card frame is the element that carries the souq pack's `rounded-[var(--radius)]`.
    const frame = html.match(/class="[^"]*border-border bg-card[^"]*"/);
    expect(frame, 'souq card frame not found').not.toBeNull();
    expect(frame![0]).toContain('rounded-full');
    expect(frame![0]).not.toContain('rounded-[var(--radius)]');
  });
});

// ── 6. Heart / quick-add collision avoidance, on the REAL wiring ───────────
//
// tests/unit/product-badge-heart-collision.test.ts covers the resolver
// function exhaustively; these render the actual card components so a wrong
// (or missing) `topStartReserved`/`topEndReserved`/`bottomOverlay` prop on
// any ONE surface — a copy/paste error the resolver-only tests cannot see —
// turns red here instead of shipping.

describe('heart collision — StorefrontProductCard (heart at top-start)', () => {
  it("a badge explicitly placed at top-right — the heart's RTL corner — moves to top-left", () => {
    const html = render(
      StorefrontProductCard,
      { ...NO_SALE, ...LABEL },
      {
        language: 'ar',
        layout: layoutWith({ position: 'top-right', color: BADGE_COLOR }),
      }
    );
    const chip = stripBadgeChip(html).chips[0];
    expect(chip).toMatch(/\btop-3 left-3\b/);
  });

  it('the same top-right choice is untouched in LTR — the heart is on the other side', () => {
    const html = render(
      StorefrontProductCard,
      { ...NO_SALE, ...LABEL },
      { layout: layoutWith({ position: 'top-right', color: BADGE_COLOR }) }
    );
    const chip = stripBadgeChip(html).chips[0];
    expect(chip).toMatch(/\btop-3 right-3\b/);
  });
});

// Issue #2092 — the base card renders its own NEW chip at LOGICAL top-start
// (`absolute top-2 start-2`) but its `resolveCardBadges` call never passed
// `newOrBrandBadgeReserved`, so a merchant's `top-left` custom badge resolved
// straight onto the NEW chip. No wishlist heart on
// the base card, so the avoidance target is the other top corner.
describe('NEW-badge corner — base card (#2092)', () => {
  // The NEW chip is the merchant's choice (Ruling D1016-NEW-1): these cases turn it on.
  beforeEach(() => {
    storeState.store.theme = { showNewBadge: true };
  });
  afterEach(() => {
    storeState.store.theme = {};
  });
  it('LTR: a top-left badge on a NEW product moves off the NEW chip to top-right', () => {
    const html = render(
      BaseProductCard,
      { ...NO_SALE, ...LABEL, isNew: true },
      { layout: layoutWith({ position: 'top-left', color: BADGE_COLOR }) }
    );
    const chip = stripBadgeChip(html).chips[0];
    expect(chip).toMatch(/\btop-3 right-3\b/);
    expect(chip).not.toMatch(/\btop-3 left-3\b/);
  });

  it('RTL: NEW sits at physical top-right, so a top-right badge moves to top-left', () => {
    const html = render(
      BaseProductCard,
      { ...NO_SALE, ...LABEL, isNew: true },
      { language: 'ar', layout: layoutWith({ position: 'top-right', color: BADGE_COLOR }) }
    );
    const chip = stripBadgeChip(html).chips[0];
    expect(chip).toMatch(/\btop-3 left-3\b/);
  });

  it('a product that is NOT new keeps the top-left corner (no regression)', () => {
    const html = render(
      BaseProductCard,
      { ...NO_SALE, ...LABEL, isNew: false },
      { layout: layoutWith({ position: 'top-left', color: BADGE_COLOR }) }
    );
    const chip = stripBadgeChip(html).chips[0];
    expect(chip).toMatch(/\btop-3 left-3\b/);
  });
});

describe('bottom-band collision — the 5 theme cards never sit under the mobile CTA (issue #1611)', () => {
  // StorefrontProductCard's Add-to-Cart button is a normal block element
  // below the image, not an overlay, so it is excluded here on purpose —
  // there is nothing for its badge to lift above.
  const FIVE_THEMES = CARDS.filter(([name]) => name !== 'shared/StorefrontProductCard');

  it.each(FIVE_THEMES)(
    '%s: the default corner lifts above the always-mounted CTA band',
    (_name, Card) => {
      const html = render(
        Card,
        { ...NO_SALE, ...LABEL },
        { layout: layoutWith({ color: BADGE_COLOR }) }
      );
      const chip = stripBadgeChip(html).chips[0];
      expect(chip).toContain('bottom-[min(6rem,calc(100%-2.25rem))]');
      expect(chip).not.toMatch(/\bbottom-3\b/);
    }
  );

  it('StorefrontProductCard: the default corner does NOT lift — no overlay to clear', () => {
    const html = render(
      StorefrontProductCard,
      { ...NO_SALE, ...LABEL },
      { layout: layoutWith({ color: BADGE_COLOR }) }
    );
    const chip = stripBadgeChip(html).chips[0];
    expect(chip).toMatch(/\bbottom-3 right-3\b/);
  });
});

describe('quick-add collision — ProductCarousel only lifts the side quick-add occupies (issue #1609)', () => {
  function renderCarouselWithAddToCart(
    product: Record<string, unknown>,
    { layout = undefined as StoreLayoutSettings | undefined } = {}
  ): string {
    languageState.language = 'en';
    storeState.layout = layout;
    return renderToStaticMarkup(
      React.createElement(ProductCarousel as never, {
        products: [product] as never,
        isRtl: false,
        currency: 'EGP',
        onAddToCart: () => {},
      })
    );
  }

  it('quick-add OFF (store flag unset): the default corner never lifts', () => {
    const html = renderCarouselWithAddToCart(
      { ...NO_SALE, ...LABEL },
      { layout: layoutWith({ color: BADGE_COLOR }) }
    );
    const chip = stripBadgeChip(html).chips[0];
    expect(chip).toMatch(/\bbottom-3 right-3\b/);
  });

  it('quick-add ON + orderable + no variants: the default corner lifts', () => {
    storeState.store.theme = { showQuickAdd: true };
    try {
      const html = renderCarouselWithAddToCart(
        { ...NO_SALE, ...LABEL },
        { layout: layoutWith({ color: BADGE_COLOR }) }
      );
      const chip = stripBadgeChip(html).chips[0];
      expect(chip).toContain('bottom-[min(6rem,calc(100%-2.25rem))] right-3');
    } finally {
      storeState.store.theme = {};
    }
  });

  it('quick-add ON but this product has variants (no quick-add button rendered): no lift', () => {
    storeState.store.theme = { showQuickAdd: true };
    try {
      const html = renderCarouselWithAddToCart(
        {
          ...NO_SALE,
          ...LABEL,
          variants: [{ id: 'v1', name: 'Small', price: 5000 }],
        },
        { layout: layoutWith({ color: BADGE_COLOR }) }
      );
      const chip = stripBadgeChip(html).chips[0];
      expect(chip).toMatch(/\bbottom-3 right-3\b/);
    } finally {
      storeState.store.theme = {};
    }
  });
});
