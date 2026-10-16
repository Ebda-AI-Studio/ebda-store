import { describe, it, expect } from 'vitest';
import { pickLocalizedName } from '../../apps/web/src/templates/shared/display-helpers';

describe('store name localisation (pickLocalizedName)', () => {
  it('Arabic name in ar, canonical name in en', () => {
    const s = { name: 'Qamar Atelier', nameAr: 'أتيليه قمر' };
    expect(pickLocalizedName(s, true)).toBe('أتيليه قمر');
    expect(pickLocalizedName(s, false)).toBe('Qamar Atelier');
  });
  it('falls back across languages, never to an empty header', () => {
    expect(pickLocalizedName({ name: 'Qamar', nameAr: null }, true)).toBe('Qamar');
    expect(pickLocalizedName({ name: 'Qamar', nameAr: '   ' }, true)).toBe('Qamar');
    expect(pickLocalizedName({ name: '', nameAr: 'قمر' }, false)).toBe('قمر');
    expect(pickLocalizedName(null, true)).toBeUndefined();
  });
});
