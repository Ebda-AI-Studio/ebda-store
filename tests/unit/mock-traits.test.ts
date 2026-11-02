/**
 * TEMPLATES-MOCK-2/-3/-4: mock traits are validated, resettable theme overrides that change what the look emits.
 * Merchant > look > skin; a store with no look is untouched; unset keeps the look's mock default.
 */
import { describe, it, expect } from 'vitest';
import {
  DRAFT_THEME_KEYS,
  HERO_RATIOS,
  GRID_GUTTERS,
  CARD_CHROME,
  HEADING_WEIGHTS,
  PRICE_COLOURS,
  lookTraitAttrs,
  traitDefault,
  TAB_BARS,
  resolveTabBar,
  LOOK_OWNED_THEME_KEYS,
  THEME_SETTINGS_SCHEMA,
  draftThemeSchema,
  isShown,
  lookCssVars,
  mockCssVars,
} from '@ebda/shared';
import { tabBarShownOn, isHomePath } from '../../apps/web/src/templates/shared/tab-bar-visibility';
import { themeSchema } from '../../apps/api/src/lib/theme-schema';

const control = (id: string) =>
  THEME_SETTINGS_SCHEMA.flatMap(g => g.settings).find(s => String(s.id) === id)!;

function validated(key: string, values: readonly string[]) {
  expect(DRAFT_THEME_KEYS).toContain(key);
  expect(LOOK_OWNED_THEME_KEYS).toContain(key);
  expect(draftThemeSchema.safeParse({ [key]: null }).success).toBe(true);
  for (const v of values) {
    expect(themeSchema.safeParse({ [key]: v }).success).toBe(true);
    expect(draftThemeSchema.safeParse({ [key]: v }).success).toBe(true);
  }
  expect(themeSchema.safeParse({ [key]: 'nope' }).success).toBe(false);
  expect(themeSchema.safeParse({ [key]: '<script>' }).success).toBe(false);
  const c = control(key);
  expect(c.trait).toBe(true);
  expect(c.labelAr.length).toBeGreaterThan(2);
  expect(c.hintAr?.length).toBeGreaterThan(10);
  for (const t of ['qamar', 'souq', 'jasmine', 'lamma', 'dahab'])
    expect(isShown(c, { template: t })).toBe(true);
}

describe('heroRatio (P2)', () => {
  it('is validated, draftable, look-owned, shown on all five skins', () =>
    validated('heroRatio', HERO_RATIOS));

  it('unset keeps the look mock ratio; a pick overrides it; wide restores the old crop', () => {
    expect(mockCssVars('qamar.atelier', {})['--look-hero-aspect']).toBe('3 / 4');
    expect(mockCssVars('qamar.atelier', { heroRatio: 'square' })['--look-hero-aspect']).toBe(
      '1 / 1'
    );
    expect(mockCssVars('qamar.atelier', { heroRatio: 'tall' })['--look-hero-aspect']).toBe('4 / 5');
    expect(mockCssVars('qamar.atelier', { heroRatio: 'wide' })).toEqual({});
    // a look with no mock ratio still honours a pick
    expect(mockCssVars('qamar.lookbook', { heroRatio: 'tall' })['--look-hero-maxh']).toBe('none');
  });

  it('a store with no look emits nothing, whatever the key says', () => {
    expect(lookCssVars({ heroRatio: 'tall' } as never, null)).toEqual({});
  });
});

describe('tabBar (P3)', () => {
  it('is validated, draftable, look-owned, shown on all five skins', () =>
    validated('tabBar', TAB_BARS));

  it('resolves merchant > look (inner) > legacy no-look (always)', () => {
    expect(resolveTabBar({}, 'qamar.atelier')).toBe('inner');
    expect(resolveTabBar({ tabBar: 'always' }, 'qamar.atelier')).toBe('always');
    expect(resolveTabBar({ tabBar: 'never' }, null)).toBe('never');
    expect(resolveTabBar({}, null)).toBe('always');
    expect(resolveTabBar(undefined, undefined)).toBe('always');
  });

  it('inner hides the bar on the home page only; never hides it everywhere; checkout stays hidden', () => {
    expect(tabBarShownOn('/', 'inner')).toBe(false);
    expect(tabBarShownOn('/ar', 'inner')).toBe(false);
    expect(tabBarShownOn('/s/qamar/', 'inner', '/s/qamar')).toBe(false);
    expect(tabBarShownOn('/products', 'inner')).toBe(true);
    expect(tabBarShownOn('/s/qamar/products/x', 'inner', '/s/qamar')).toBe(true);
    expect(tabBarShownOn('/', 'always')).toBe(true);
    expect(tabBarShownOn('/products', 'never')).toBe(false);
    expect(tabBarShownOn('/checkout', 'always')).toBe(false);
    expect(isHomePath('/s/qamar', '/s/qamar')).toBe(true);
  });
});

describe('headingWeight + priceColour (P4)', () => {
  it('are validated, draftable, look-owned, shown on all five skins', () => {
    validated('headingWeight', HEADING_WEIGHTS);
    validated('priceColour', PRICE_COLOURS);
  });

  it('look default: bold where the display face ships a bold weight, regular on single-weight faces', () => {
    expect(traitDefault('headingWeight', 'qamar.atelier')).toBe('strong'); // Noto Naskh 400;700
    expect(traitDefault('headingWeight', 'qamar.lookbook')).toBe('regular'); // Lalezar, one weight
    expect(traitDefault('headingWeight', 'dahab.giftbox')).toBe('regular'); // Kufam, one weight
    expect(traitDefault('priceColour', 'qamar.atelier')).toBe('accent'); // light page, readable accent
    expect(traitDefault('priceColour', 'qamar.lookbook')).toBe('text'); // dark page
    expect(traitDefault('headingWeight', null)).toBeUndefined();
  });

  it('body attributes: merchant beats look; a store with no look gets none', () => {
    expect(lookTraitAttrs({}, 'qamar.atelier')).toMatchObject({
      'data-heading-weight': 'strong',
      'data-price-colour': 'accent',
    });
    expect(
      lookTraitAttrs({ headingWeight: 'regular', priceColour: 'text' }, 'qamar.atelier')
    ).toMatchObject({
      'data-heading-weight': 'regular',
      'data-price-colour': 'text',
    });
    expect(lookTraitAttrs({ headingWeight: 'strong' }, null)).toEqual({});
  });

  it('the accent price colour is emitted only when the accent reads on page and card, else the text colour stays', () => {
    const ok = lookCssVars(
      { accentColor: '350 60% 30%', backgroundColor: '0 0% 100%', cardColor: '0 0% 100%' } as never,
      'qamar.atelier'
    );
    expect(ok['--look-price-colour']).toBe('350 60% 30%');
    const pale = lookCssVars(
      {
        accentColor: '230 31% 89%',
        backgroundColor: '231 36% 18%',
        cardColor: '0 0% 98%',
      } as never,
      'qamar.lookbook'
    );
    expect(pale['--look-price-colour']).toBeUndefined();
    expect(
      lookTraitAttrs(
        {
          accentColor: '230 31% 89%',
          backgroundColor: '231 36% 18%',
          cardColor: '0 0% 98%',
        } as never,
        'qamar.lookbook'
      )['data-price-colour']
    ).toBe('text');
  });
});

describe('card chrome (P5)', () => {
  it('heart, swatches and tags are validated, draftable, look-owned, shown on all five skins', () => {
    for (const k of ['cardHeart', 'cardSwatches', 'cardTags']) validated(k, CARD_CHROME);
  });

  it('a look store defaults to bare cards; a merchant pick restores each piece on its own', () => {
    expect(lookTraitAttrs({}, 'jasmine.bloom')).toMatchObject({
      'data-card-heart': 'off',
      'data-card-swatches': 'off',
      'data-card-tags': 'off',
    });
    expect(lookTraitAttrs({ cardHeart: 'on' }, 'jasmine.bloom')).toMatchObject({
      'data-card-heart': 'on',
      'data-card-swatches': 'off',
    });
    expect(lookTraitAttrs({ cardHeart: 'on' }, null)).toEqual({}); // no look: cards untouched
  });
});

describe('gridGutter (P6)', () => {
  it('is validated, draftable, look-owned, shown on all five skins', () =>
    validated('gridGutter', GRID_GUTTERS));

  it('Atelier defaults to hairline gutters; other looks keep the old gaps; a pick overrides; no look = none', () => {
    expect(lookTraitAttrs({}, 'qamar.atelier')['data-grid-gutter']).toBe('tight');
    expect(lookTraitAttrs({}, 'souq.night')['data-grid-gutter']).toBe('regular');
    expect(lookTraitAttrs({ gridGutter: 'airy' }, 'qamar.atelier')['data-grid-gutter']).toBe(
      'airy'
    );
    expect(lookTraitAttrs({ gridGutter: 'tight' }, null)).toEqual({});
  });
});
