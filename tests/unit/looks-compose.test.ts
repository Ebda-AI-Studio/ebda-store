import { describe, it, expect } from 'vitest';
import {
  composeStoreTheme,
  getLook,
  lookTheme,
  overriddenLookKeys,
  hexToHsl,
  getTemplateTheme,
} from '@ebda/shared';

describe('composeStoreTheme', () => {
  const atelier = getLook('qamar.atelier')!;
  it('look tokens sit over the skin theme', () => {
    const t = composeStoreTheme({ template: 'minimal', look: 'qamar.atelier', theme: {} });
    expect(t.backgroundColor).toBe(hexToHsl('#FFFFFF'));
    expect(t.accentColor).toBe(hexToHsl(atelier.tokens.accent));
    expect(t.headingFont).toBe('Noto Naskh Arabic');
    expect(t.density).toBe('airy');
  });
  it('stored merchant values win over the look', () => {
    const t = composeStoreTheme({
      template: 'minimal',
      look: 'qamar.atelier',
      theme: { primaryColor: '1 2% 3%' },
    });
    expect(t.primaryColor).toBe('1 2% 3%');
  });
  it('unknown look id falls back to the skin theme, never throws', () => {
    const t = composeStoreTheme({ template: 'minimal', look: 'qamar.deleted', theme: {} });
    expect(t.primaryColor).toBe(getTemplateTheme('minimal').primaryColor);
  });
  it('null look = legacy store, unchanged behaviour', () => {
    expect(composeStoreTheme({ template: 'modern', look: null, theme: { x: 1 } as any })).toEqual({
      ...getTemplateTheme('modern'),
      x: 1,
    });
  });
  it('overriddenLookKeys lists only stored keys that differ from the look', () => {
    const lt = lookTheme(atelier);
    expect(
      overriddenLookKeys(
        { primaryColor: lt.primaryColor, accentColor: '0 0% 0%', showQuickAdd: true },
        atelier
      )
    ).toEqual(['accentColor']);
  });
});

describe('lookTheme key guard', () => {
  it('every look sets exactly LOOK_TOKEN_KEYS (no more, no fewer)', async () => {
    const { LOOKS, LOOK_TOKEN_KEYS } = await import('@ebda/shared');
    for (const l of LOOKS) {
      expect(Object.keys(lookTheme(l)).sort(), l.id).toEqual([...LOOK_TOKEN_KEYS].sort());
    }
  });
});
