import { describe, it, expect } from 'vitest';
import { VARIANT_WIDTHS, canHaveVariants, isVariantKey, variantKey, variantUrl } from './variants';

describe('image variant keys (Ruling PREMIUM-2)', () => {
  it('names a variant next to its original', () => {
    expect(variantKey('stores/a/products/x.png', 960)).toBe('stores/a/products/x.w960.webp');
    expect(variantKey('stores/a/products/x.JPEG', 480)).toBe('stores/a/products/x.w480.webp');
    expect(VARIANT_WIDTHS).toEqual([480, 960, 1600]);
  });
  it('resizes only rasters that are not variants already', () => {
    expect(canHaveVariants('a/b.png')).toBe(true);
    expect(canHaveVariants('a/b.webp')).toBe(true);
    expect(canHaveVariants('a/b.svg')).toBe(false);
    expect(canHaveVariants('a/b.gif')).toBe(false);
    expect(canHaveVariants('a/b.w960.webp')).toBe(false);
    expect(isVariantKey('a/b.w960.webp')).toBe(true);
  });
  it('maps a public URL, keeping origin and query out of the way', () => {
    expect(variantUrl('https://media.ebda.app/stores/a/x.png', 480)).toBe(
      'https://media.ebda.app/stores/a/x.w480.webp'
    );
    expect(variantUrl('not a url', 480)).toBe('not a url');
  });
});
