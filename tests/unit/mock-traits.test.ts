/**
 * TEMPLATES-MOCK-2/-3/-4: mock traits are validated, resettable theme overrides that change what the look emits.
 * Merchant > look > skin; a store with no look is untouched; unset keeps the look's mock default.
 */
import { describe, it, expect } from 'vitest';
import {
  DRAFT_THEME_KEYS,
  HERO_RATIOS,
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
