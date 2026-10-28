/**
 * W2a Lookbook (taste gate LB-01, LB-03, LB-04, LB-05, LB-06):
 * - LB-01: the categories row and the new-in grid sit on the inverse band (`token:inverse`):
 *   the page ink as ground, the ink variables swapped inside it, every text pair measured here.
 * - LB-03: Archivo (Lookbook's Latin display only) loads one heavy weight.
 * - LB-04: the look photo field tells the merchant the photo shows every piece.
 * - LB-05: on the qamar skin the builder section header uses the skin's one "view all" voice
 *   and one hairline colour; every other skin's header is unchanged.
 * - LB-06: the strip keeps its inline-start gutter when it snaps.
 */
import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  COLOR_TOKENS,
  INVERSE_SURFACE,
  LOOK_FONT_SPECS,
  composeStoreTheme,
  contrastRatio,
  getLook,
  getSectionDefinition,
  resolveColor,
  storeLayoutSchema,
} from '@ebda/shared';
import {
  darkLookListingBand,
  sectionBgStyle,
} from '../../apps/web/src/templates/shared/section-bg';
import { getPackStyles } from '../../apps/web/src/templates/shared/pack-styles';

const ctx = vi.hoisted(() => ({ template: 'qamar' }));
vi.mock('../../apps/web/src/contexts/StoreContext', () => ({
  useStore: () => ({ store: { template: ctx.template } }),
}));
vi.mock('next/link', () => ({
  __esModule: true,
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) =>
    React.createElement('a', { href, ...rest }, children),
}));
const { SectionHeader } = await import('../../apps/web/src/builder/sections/SectionHeader');

const web = path.resolve(__dirname, '../../apps/web/src');
const hsl = (triplet: string) => `hsl(${triplet})`;
/** fg at alpha over an opaque bg, both given as hex. */
const over = (fg: string, a: number, bg: string) => {
  const c = (h: string, i: number) => parseInt(h.slice(i, i + 2), 16);
  return (
    '#' +
    [1, 3, 5]
      .map(i =>
        Math.round(c(fg, i) * a + c(bg, i) * (1 - a))
          .toString(16)
          .padStart(2, '0')
      )
      .join('')
  );
};

describe('LB-01 inverse band', () => {
  const look = getLook('qamar.lookbook')!;
  const theme = composeStoreTheme({ template: 'qamar', look: look.id, theme: {} });
  const style = sectionBgStyle(INVERSE_SURFACE, theme) as Record<string, string>;

  it('Lookbook puts the categories row and the new-in grid on the band; looks and reviews stay indigo', () => {
    const design = (type: string) =>
      (look.sections!.find(s => s.type === type)!.design ?? {}) as Record<string, unknown>;
    expect(design('category-grid').bgColor).toBe('token:inverse');
    expect(design('featured-collection').bgColor).toBe('token:inverse');
    expect(design('shop-the-look').bgColor).toBe('token:card');
    expect(design('testimonials').bgColor).toBeUndefined();
  });

  it('the band paints the page ink and swaps the ink variables inside it', () => {
    expect(style.backgroundColor).toBe(hsl(theme.foregroundColor));
    expect(style['--foreground']).toBe(theme.backgroundColor);
    expect(style['--card-foreground']).toBe(theme.backgroundColor);
    expect(style['--muted-foreground']).toBe(theme.backgroundColor);
    expect(style['--input']).toBe(theme.backgroundColor);
    expect(style['--background']).toBe(theme.foregroundColor);
  });

  // W2b (live, Lookbook /search 390): text that INHERITS (an h1 with no colour class) kept the
  // page's light ink, and `text-primary` prices / chips were saffron on the light band (1.9:1).
  it('the band sets its own text colour and remaps primary to the ink pair (fills stay readable)', () => {
    expect(style.color).toBe(hsl(theme.backgroundColor));
    expect(style['--primary']).toBe(theme.backgroundColor);
    expect(style['--primary-foreground']).toBe(theme.foregroundColor);
    expect(style['--ring']).toBe(theme.backgroundColor);
    // B1-102: moon silver is 1.2:1 against the light band, so the accent (sale / new chips) takes
    // the same indigo-fill / light-text pair as the primary inside the band.
    expect(style['--accent']).toBe(theme.backgroundColor);
    expect(style['--accent-foreground']).toBe(theme.foregroundColor);
  });

  // T10 (live, Lookbook /search 390): the "-21%" sale text was the PAGE-derived destructive ink
  // (light pink) on the light band, 1.83:1. The band derives the status inks again against itself.
  it('status inks inside the band read >= 4.5:1 on the band (sale %, error, success)', () => {
    for (const role of ['destructive', 'success', 'warning'] as const) {
      const ink = style[`--${role}-ink`]!;
      expect(ink, role).toBeDefined();
      expect(ink, role).not.toMatch(/^var\(/);
      expect(contrastRatio(hsl(theme.foregroundColor), hsl(ink)), role).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('every text pair on the band is >= 4.5:1 (ink, prices, the 70% link), the button keeps its pair', () => {
    const band = look.tokens.ink; // #F4F1FA
    const text = look.tokens.page; // #1E2340
    expect(contrastRatio(band, text)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(band, over(text, 0.7, band))).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(look.tokens.primary, look.tokens.onPrimary)).toBeGreaterThanOrEqual(4.5);
    // and the saffron accent is never text on the band (1.93:1): prices read --foreground
    expect(contrastRatio(band, look.tokens.primary)).toBeLessThan(3);
    expect(getPackStyles('qamar').productCardPrice).toContain('text-foreground');
  });

  it('section headings auto-contrast against the band (resolveColor paints it as the ink)', () => {
    expect(resolveColor(INVERSE_SURFACE, theme)).toBe(resolveColor('token:foreground', theme));
    const strip = readFileSync(path.join(web, 'templates/shared/CategoryStrip.tsx'), 'utf8');
    expect(strip).toContain('sectionBgColor={onLook ? sectionBgColor : undefined}');
    expect(strip).toContain('const onLook = !!getLook(store?.look);');
  });

  it('a look-only value: accepted by the schema, never offered in a colour picker', () => {
    // the shared colorValue rule, through the hero section's bgColor
    const h = storeLayoutSchema.shape.hero;
    const base = { enabled: true, mode: 'single', autoplayMs: 5000, slides: [] };
    expect(h.safeParse({ ...base, bgColor: 'token:inverse' }).success).toBe(true);
    expect(h.safeParse({ ...base, bgColor: 'token:nope' }).success).toBe(false);
    expect((COLOR_TOKENS as readonly string[]).includes('inverse')).toBe(false);
  });

  it('every other bg value is painted exactly as before', () => {
    expect(sectionBgStyle('#112233', theme)).toEqual({ backgroundColor: '#112233' });
    expect(sectionBgStyle(undefined, theme)).toBeUndefined();
    expect(sectionBgStyle('token:card', theme)).toEqual({
      backgroundColor: resolveColor('token:card', theme),
    });
  });
});

describe('LB-03 Latin display weight', () => {
  it('Archivo loads one heavy weight (800) for the poster voice', () => {
    expect(getLook('qamar.lookbook')!.tokens.fonts.latin).toBe('Archivo');
    expect(LOOK_FONT_SPECS.Archivo).toBe('wght@800');
  });
});

describe('LB-04 look photo hint', () => {
  it('the look block photo field says it shows every piece (ar + en)', () => {
    const stl = getSectionDefinition('shop-the-look')!;
    const image = stl.blocks![0].settings.find(s => s.id === 'image')!;
    expect(image.labelEn).toBe('Photo (shows every piece)');
    expect(image.labelAr).toBe('الصورة (تظهر فيها كل القطع)');
  });
});

describe('LB-05 one link voice and one rule colour on qamar', () => {
  const render = () =>
    renderToStaticMarkup(
      React.createElement(SectionHeader, {
        title: 'New in',
        linkLabel: 'See all',
        linkHref: '/products',
      })
    );
  it('qamar: the SectionHeading link classes, no chevron, a single bg-border hairline', () => {
    ctx.template = 'qamar';
    const html = render();
    expect(html).toContain(getPackStyles('qamar').sectionSeeAll);
    expect(html).not.toContain('<svg');
    expect(html).not.toContain('text-primary');
    expect(html).toContain('class="mt-5 h-px bg-border"');
    expect(html).not.toContain('bg-gradient-to-r');
  });
  it('every other skin: the primary link with its chevron and the gradient rule, unchanged', () => {
    for (const t of ['dahab']) {
      ctx.template = t;
      const html = render();
      expect(html).toContain('text-sm text-primary underline-offset-4');
      expect(html).toContain('<svg');
      expect(html).toContain('bg-gradient-to-r from-primary/50 via-border to-transparent');
    }
  });
});

describe('LB-06 strip gutter', () => {
  it('the strip snaps with an inline-start scroll padding equal to its gutter', () => {
    const strip = readFileSync(path.join(web, 'templates/shared/CategoryStrip.tsx'), 'utf8');
    expect(strip).toContain("snap-x snap-mandatory ${onLook ? 'scroll-ps-4 ' : ''}");
    const look = getLook('qamar.lookbook')!;
    expect(look.sections!.find(s => s.type === 'category-grid')!.design).toMatchObject({
      paddingBottom: 'tight',
    });
  });
});

// W2a fix round 1 (review I-3): quality bar § 9 rule 1 reaches the listing pages too.
describe('LB-01 on listings: a dark look lists products on the inverse band', () => {
  const theme = (look: string | null, template = 'qamar') =>
    composeStoreTheme({ template: template as never, look, theme: {} });
  it('Lookbook (dark page): the band, painted as the section band is', () => {
    const t = theme('qamar.lookbook');
    expect(darkLookListingBand(t, 'qamar.lookbook', false)).toEqual(
      sectionBgStyle(INVERSE_SURFACE, t)
    );
  });
  it('a light look, a store with no look, or a merchant page colour: unchanged', () => {
    expect(darkLookListingBand(theme('qamar.atelier'), 'qamar.atelier', false)).toBeUndefined();
    expect(darkLookListingBand(theme('qamar.vitrine'), 'qamar.vitrine', false)).toBeUndefined();
    const darkLegacy = { ...theme(null, 'souq'), backgroundColor: '230 36% 18%' };
    expect(darkLookListingBand(darkLegacy, null, false)).toBeUndefined();
    expect(darkLookListingBand(theme('qamar.lookbook'), 'qamar.lookbook', true)).toBeUndefined();
  });
  it('the PLP and search results use it (merchant page colour first on the PLP)', () => {
    const plp = readFileSync(path.join(web, 'app/products/ProductsClient.tsx'), 'utf8');
    expect(plp).toContain(
      'darkLookListingBand(store.theme, store.look, !!productsPage?.bgColor) ??'
    );
    const search = readFileSync(path.join(web, 'app/search/SearchClient.tsx'), 'utf8');
    expect(search).toContain('darkLookListingBand(store?.theme, store?.look, false)');
  });
  it('W2b: the categories page too (its category photos are shot on white), merchant colour first', () => {
    const cats = readFileSync(path.join(web, 'app/categories/CategoriesClient.tsx'), 'utf8');
    expect(cats).toContain('darkLookListingBand(store.theme, store.look, !!catPage?.bgColor);');
  });
});

// STOP-2 P2-5 / Ruling B1-108: the category page IS the products listing (`/products?category=`),
// so the three listing pages must keep sharing the ONE dark-look rule. A page that painted its own
// canvas would split the look mid-site.
describe('listing pages share one dark-look rule (B1-108)', () => {
  it.each([
    'products/ProductsClient.tsx',
    'categories/CategoriesClient.tsx',
    'search/SearchClient.tsx',
  ])('%s paints the listing through darkLookListingBand', f => {
    const src = readFileSync(path.join(web, 'app', f), 'utf8');
    expect(src).toContain('darkLookListingBand(');
  });
});
