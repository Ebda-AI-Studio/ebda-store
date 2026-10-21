import { describe, it, expect } from 'vitest';
import { BRAND, composeStoreTheme } from '@ebda/shared';
import { storeThemeColor } from './theme-color';

// K-08 (W3): the browser chrome colour is the store's own page colour, not Ebda's night.
describe('storeThemeColor', () => {
  it('a store paints its page colour (HSL triplet -> hsl())', () => {
    const atelier = composeStoreTheme({ template: 'qamar', look: 'qamar.atelier', theme: {} });
    expect(storeThemeColor(atelier)).toBe(`hsl(${atelier.backgroundColor})`);
    const lookbook = composeStoreTheme({ template: 'qamar', look: 'qamar.lookbook', theme: {} });
    expect(storeThemeColor(lookbook)).toBe(`hsl(${lookbook.backgroundColor})`);
  });
  it('a hex page colour passes through', () => {
    expect(storeThemeColor({ backgroundColor: '#fafafa' } as never)).toBe('#fafafa');
  });
  it('no store or no colour: the platform colour', () => {
    expect(storeThemeColor(undefined)).toBe(BRAND.colors.night);
    expect(storeThemeColor({} as never)).toBe(BRAND.colors.night);
  });
});
