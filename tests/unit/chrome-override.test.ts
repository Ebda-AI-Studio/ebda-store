/**
 * Ruling EP-4: the merchant's header chrome (logo position, search) is an override in the theme
 * draft. Precedence merchant > look > skin. Clearing it falls back to the look; a design reset
 * clears it; the theme PUT and the draft refuse any other value.
 */
import { describe, it, expect } from 'vitest';
import {
  DRAFT_THEME_KEYS,
  LOOK_OWNED_THEME_KEYS,
  THEME_SETTINGS_SCHEMA,
  applyThemePatch,
  draftThemeSchema,
  getLook,
  isShown,
  overriddenLookKeys,
  resolveHeaderChrome,
} from '@ebda/shared';
import { themeSchema } from '../../apps/api/src/lib/theme-schema';

const centred = getLook('qamar.vitrine')!;
const left = getLook('qamar.atelier')!;

describe('resolveHeaderChrome', () => {
  it('a store with no override draws exactly the look (and the skin default without a look)', () => {
    expect(centred.chrome?.header.logoPlacement).toBe('centre');
    expect(resolveHeaderChrome({}, centred.chrome?.header).logoPlacement).toBe('centre');
    expect(resolveHeaderChrome({}, left.chrome?.header).logoPlacement).toBe('start');
    expect(resolveHeaderChrome(undefined, undefined)).toEqual({
      logoPlacement: 'start',
      search: 'icon',
    });
  });

  it('the merchant beats the look, either way round', () => {
    expect(
      resolveHeaderChrome({ headerLogoPlacement: 'start' }, centred.chrome?.header).logoPlacement
    ).toBe('start');
    expect(
      resolveHeaderChrome({ headerLogoPlacement: 'centre' }, left.chrome?.header).logoPlacement
    ).toBe('centre');
    const souq = getLook('souq.catalogue')!;
    expect(souq.chrome?.header.search).toBe('prominent');
    expect(resolveHeaderChrome({ headerSearch: 'icon' }, souq.chrome?.header).search).toBe('icon');
  });

  it('clearing the override in the draft (null) falls back to the look', () => {
    const live = { headerLogoPlacement: 'start' };
    const cleared = applyThemePatch(live, { headerLogoPlacement: null });
    expect(resolveHeaderChrome(cleared, centred.chrome?.header).logoPlacement).toBe('centre');
  });
});

describe('the override rides the draft and is validated', () => {
  it('is an editable draft theme key with a string value from the list only', () => {
    expect(DRAFT_THEME_KEYS).toContain('headerLogoPlacement');
    expect(DRAFT_THEME_KEYS).toContain('headerSearch');
    expect(draftThemeSchema.safeParse({ headerLogoPlacement: 'centre' }).success).toBe(true);
    expect(draftThemeSchema.safeParse({ headerLogoPlacement: null }).success).toBe(true);
    expect(draftThemeSchema.safeParse({ headerLogoPlacement: true }).success).toBe(false);
  });

  it('the theme PUT accepts only the known placements (or null = delete)', () => {
    expect(themeSchema.safeParse({ headerLogoPlacement: 'centre' }).success).toBe(true);
    expect(themeSchema.safeParse({ headerSearch: 'prominent' }).success).toBe(true);
    expect(themeSchema.safeParse({ headerLogoPlacement: null }).success).toBe(true);
    expect(themeSchema.safeParse({ headerLogoPlacement: 'left' }).success).toBe(false);
    expect(themeSchema.safeParse({ headerSearch: '<script>' }).success).toBe(false);
  });
});

describe('look switch', () => {
  it('a design reset clears the override, a keep leaves it (it is look-owned for the reset list)', () => {
    expect(LOOK_OWNED_THEME_KEYS).toContain('headerLogoPlacement');
    expect(LOOK_OWNED_THEME_KEYS).toContain('headerSearch');
  });

  it('a stored override is reported as edited, with a way back to the look', () => {
    expect(overriddenLookKeys({ headerLogoPlacement: 'start' }, centred)).toContain(
      'headerLogoPlacement'
    );
    expect(overriddenLookKeys({}, centred)).not.toContain('headerLogoPlacement');
  });
});

describe('the controls', () => {
  const group = THEME_SETTINGS_SCHEMA.find(g => g.id === 'header')!;
  const logo = group.settings.find(s => s.id === 'headerLogoPlacement')!;
  const search = group.settings.find(s => s.id === 'headerSearch')!;

  it('the header group is first, like the header on the storefront', () => {
    expect(THEME_SETTINGS_SCHEMA[0].id).toBe('header');
  });

  it('logo position is offered on the skins built on the minimal header, search on Souq only', () => {
    for (const t of ['qamar', 'souq', 'jasmine', 'lamma'])
      expect(isShown(logo, { template: t })).toBe(true);
    for (const t of ['modern', 'dahab', 'classic'])
      expect(isShown(logo, { template: t })).toBe(false);
    expect(isShown(search, { template: 'souq' })).toBe(true);
    expect(isShown(search, { template: 'qamar' })).toBe(false);
  });
});
