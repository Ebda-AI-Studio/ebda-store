/**
 * Ruling VE-17: the five product-card switches the form page builder used to own now live in the
 * visual editor's theme pane. They must ride the draft theme (accepted as booleans only, published
 * with the page), reach `PUT /theme` as strict booleans, never be written by a look switch or by
 * Smart Palette, and be searchable.
 */
import { describe, it, expect } from 'vitest';
import {
  DRAFT_THEME_KEYS,
  LOOKS,
  THEME_SETTINGS_SCHEMA,
  applySmartPalette,
  draftThemeSchema,
  layoutToDefinition,
  lookTheme,
  resolveLayoutSettings,
  snapshotEditableTheme,
} from '@ebda/shared';
import { themeSchema, THEME_BOOLEAN_KEYS } from '../../apps/api/src/lib/theme-schema';

const KEYS = [
  'showBrandBadge',
  'showNewBadge',
  'showQuickAdd',
  'normalizeProductImages',
  'saleBadgeLegacyCorner',
] as const;

describe('product-card theme switches (VE-17)', () => {
  it('are checkboxes in the cards group, bilingual, with a hint', () => {
    const group = THEME_SETTINGS_SCHEMA.find(g => g.id === 'cards')!;
    expect(group.settings.map(s => s.id)).toEqual([...KEYS]);
    for (const s of group.settings) {
      expect(s.type).toBe('checkbox');
      expect(s.labelAr).toMatch(/[ء-ي]/);
      expect(s.hintEn && s.hintAr).toBeTruthy();
      // a reader exists on shared cards: nothing is hidden by template
      expect(s.shownFor).toBeUndefined();
      expect(s.labelAr + (s.hintAr ?? '')).not.toContain('#');
    }
  });

  it('the draft accepts booleans and null (reset), refuses strings', () => {
    for (const k of KEYS) {
      expect(DRAFT_THEME_KEYS).toContain(k);
      expect(draftThemeSchema.safeParse({ [k]: true }).success).toBe(true);
      expect(draftThemeSchema.safeParse({ [k]: null }).success).toBe(true);
      expect(draftThemeSchema.safeParse({ [k]: 'false' }).success).toBe(false);
    }
  });

  it('a publish snapshot records them so a rollback restores them', () => {
    const snap = snapshotEditableTheme({ showNewBadge: true }, { showQuickAdd: true });
    expect(snap).toMatchObject({ showNewBadge: true, showQuickAdd: true });
  });

  it('PUT /theme takes them as strict booleans', () => {
    expect([...THEME_BOOLEAN_KEYS].sort()).toEqual([...KEYS].sort());
    for (const k of KEYS) {
      expect(themeSchema.safeParse({ [k]: true }).success).toBe(true);
      expect(themeSchema.safeParse({ [k]: null }).success).toBe(true);
      expect(themeSchema.safeParse({ [k]: 'false' }).success).toBe(false);
    }
  });

  it('design reset: no look owns them, so a look switch (keep or reset) never clears them', () => {
    for (const look of LOOKS)
      for (const k of KEYS)
        expect(Object.keys(lookTheme(look)), `${look.id}.${k}`).not.toContain(k);
  });

  it('Smart Palette never writes them', () => {
    const doc = layoutToDefinition(resolveLayoutSettings({}, 'qamar'));
    const out = applySmartPalette(doc, {}, Object.fromEntries(KEYS.map(k => [k, true])));
    for (const k of KEYS) expect(out.theme?.[k], k).toBeUndefined();
  });
});
