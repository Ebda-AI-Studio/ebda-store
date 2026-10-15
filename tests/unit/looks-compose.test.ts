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
  it('every look sets exactly LOOK_TOKEN_KEYS plus the UI tokens it declares (no more, no fewer)', async () => {
    const { LOOKS, LOOK_TOKEN_KEYS, LOOK_UI_TOKEN_KEYS } = await import('@ebda/shared');
    for (const l of LOOKS) {
      const declared = LOOK_UI_TOKEN_KEYS.filter(k => l.tokens[k] !== undefined);
      expect(Object.keys(lookTheme(l)).sort(), l.id).toEqual(
        [...LOOK_TOKEN_KEYS, ...declared].sort()
      );
    }
  });
});

describe('look UI tokens (W2a token plumbing): merchant > look > skin', () => {
  it('Atelier declares its values; the composed theme carries them', () => {
    const t = composeStoreTheme({ template: 'qamar', look: 'qamar.atelier', theme: {} });
    expect(t).toMatchObject({
      wordmarkSize: 'lg',
      overPhotoChrome: 'bare',
      receiptStyle: 'framed',
    });
  });
  it('a stored merchant value beats the look', () => {
    const t = composeStoreTheme({
      template: 'qamar',
      look: 'qamar.atelier',
      theme: { wordmarkSize: 'xl', overPhotoChrome: 'soft' },
    });
    expect(t.wordmarkSize).toBe('xl');
    expect(t.overPhotoChrome).toBe('soft');
    expect(t.receiptStyle).toBe('framed');
  });
  it('a look that does not declare a token leaves the skin behaviour (undefined)', () => {
    const t = composeStoreTheme({ template: 'minimal', look: 'souq.catalogue', theme: {} });
    expect(t.wordmarkSize).toBeUndefined();
    expect(t.overPhotoChrome).toBeUndefined();
    expect(t.receiptStyle).toBeUndefined();
  });
  it('no look: the composed theme is the skin theme byte-for-byte (no UI token appears)', async () => {
    const { LOOK_UI_TOKEN_KEYS } = await import('@ebda/shared');
    const skins = ['modern', 'classic', 'minimal', 'bold', 'elegant', 'dahab', 'qamar'] as const;
    for (const template of skins) {
      const t = composeStoreTheme({ template, look: null, theme: {} });
      expect(JSON.stringify(t), template).toBe(JSON.stringify(getTemplateTheme(template)));
      for (const k of LOOK_UI_TOKEN_KEYS) expect(k in t, `${template}.${k}`).toBe(false);
    }
  });
  it('only the Qamar looks declare UI tokens today (Dahab and the designed looks are unchanged)', async () => {
    const { LOOKS, LOOK_UI_TOKEN_KEYS } = await import('@ebda/shared');
    for (const l of LOOKS.filter(x => x.template !== 'qamar'))
      for (const k of LOOK_UI_TOKEN_KEYS) expect(l.tokens[k], `${l.id}.${k}`).toBeUndefined();
  });
  it('overriddenLookKeys reports a merchant UI-token override', () => {
    expect(
      overriddenLookKeys({ wordmarkSize: 'xl', receiptStyle: 'framed' }, atelierLook())
    ).toEqual(['wordmarkSize']);
  });
});

function atelierLook() {
  return getLook('qamar.atelier')!;
}
