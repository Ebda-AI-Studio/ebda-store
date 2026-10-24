import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pickLocalizedName } from '../../apps/web/src/templates/shared/display-helpers';

// Issue #2110 (the #1805 class): `nameAr` can be '' (the API's product schema
// has no `.min(1)`), and `nameAr ?? name` does not fall back on ''. On a
// storefront DISPLAY path that renders a BLANK product/category name.
describe('pickLocalizedName', () => {
  it('AR: a blank or whitespace nameAr falls back to the English name', () => {
    expect(pickLocalizedName({ name: 'Honey', nameAr: '' }, true)).toBe('Honey');
    expect(pickLocalizedName({ name: 'Honey', nameAr: '   ' }, true)).toBe('Honey');
    expect(pickLocalizedName({ name: 'Honey', nameAr: null }, true)).toBe('Honey');
  });

  it('AR: a real nameAr wins; EN: the English name wins', () => {
    expect(pickLocalizedName({ name: 'Honey', nameAr: 'عسل' }, true)).toBe('عسل');
    expect(pickLocalizedName({ name: 'Honey', nameAr: 'عسل' }, false)).toBe('Honey');
  });

  it('EN: a blank English name falls back to Arabic; both blank → undefined', () => {
    expect(pickLocalizedName({ name: '', nameAr: 'عسل' }, false)).toBe('عسل');
    expect(pickLocalizedName({ name: '', nameAr: '' }, true)).toBeUndefined();
    expect(pickLocalizedName(undefined, true)).toBeUndefined();
  });
});

// The helper only helps where it is used. Pin the storefront display paths
// the audit named — including ProductCarousel, one of the 8 mandated product
// render paths — so the `nameAr ?? name` idiom cannot return to them.
const DISPLAY_PATHS = [
  'apps/web/src/templates/shared/ProductCarousel.tsx',
  'apps/web/src/templates/shared/CategoryStrip.tsx',
  'apps/web/src/templates/shared/StorefrontProductCard.tsx',
  'apps/web/src/templates/base/ProductCard.tsx',
  'apps/web/src/app/products/ProductListItem.tsx',
  'apps/web/src/app/products/ProductsClient.tsx',
  'apps/web/src/components/FrequentlyBoughtTogether.tsx',
];

describe('no `nameAr ?? name` on a storefront display path (#2110)', () => {
  it.each(DISPLAY_PATHS)('%s', rel => {
    const src = readFileSync(join(__dirname, '../..', rel), 'utf8');
    expect(src).not.toMatch(/nameAr\s*\?\?\s*[\w.?]*name\b/);
  });
});
