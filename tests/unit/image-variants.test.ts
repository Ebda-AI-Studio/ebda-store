import { describe, it, expect } from 'vitest';
import {
  IMAGE_ORIGINAL_SRCSET_WIDTH,
  IMAGE_VARIANT_WIDTHS,
  baseKeyOfVariant,
  imageVariantSrcSet,
  imageVariantUrl,
  isVariantEligibleKey,
  isVariantKey,
  originalUrlOfVariant,
  pickVariantWidth,
  variantKey,
  variantKeysFor,
} from '@force/shared';

const ORIGINAL = 'https://media.ebda.app/stores/s1/products/abc-ring.jpg';

describe('image variant naming (PERF-STORE-3)', () => {
  it('appends the width + .webp to the FULL original key', () => {
    expect(variantKey('stores/s1/products/abc-ring.jpg', 720)).toBe(
      'stores/s1/products/abc-ring.jpg.w720.webp'
    );
    expect(variantKeysFor('a/b.png')).toEqual(IMAGE_VARIANT_WIDTHS.map(w => `a/b.png.w${w}.webp`));
  });

  it('round-trips variant -> original and never treats an original as a variant', () => {
    for (const w of IMAGE_VARIANT_WIDTHS) {
      const v = variantKey('stores/s1/products/abc.jpg', w);
      expect(isVariantKey(v)).toBe(true);
      expect(baseKeyOfVariant(v)).toBe('stores/s1/products/abc.jpg');
      expect(isVariantEligibleKey(v)).toBe(false);
    }
    expect(isVariantKey('stores/s1/products/abc.jpg')).toBe(false);
    expect(baseKeyOfVariant('stores/s1/products/abc.jpg')).toBeNull();
    // a merchant file literally named like a variant is an ORIGINAL (no raster ext before the suffix)
    expect(isVariantKey('stores/s1/products/photo.w720.webp')).toBe(false);
    expect(isVariantEligibleKey('stores/s1/products/photo.w720.webp')).toBe(true);
    // a width that is not a rung is not ours
    expect(isVariantKey('stores/s1/products/abc.jpg.w721.webp')).toBe(false);
  });

  it('only raster originals are eligible', () => {
    for (const k of ['a.jpg', 'a.JPEG', 'a.png', 'a.webp'])
      expect(isVariantEligibleKey(`stores/s/${k}`)).toBe(true);
    for (const k of ['a.svg', 'a.gif', 'a.avif', 'a.glb', 'a.mp4', 'a', 'a.jpg.bak'])
      expect(isVariantEligibleKey(`stores/s/${k}`)).toBe(false);
  });

  it('picks the smallest rung that covers the request, null above the top rung', () => {
    expect(pickVariantWidth(1)).toBe(480);
    expect(pickVariantWidth(432)).toBe(480);
    expect(pickVariantWidth(480)).toBe(480);
    expect(pickVariantWidth(481)).toBe(720);
    expect(pickVariantWidth(721)).toBe(960);
    expect(pickVariantWidth(1280)).toBe(1280);
    expect(pickVariantWidth(1281)).toBeNull();
    expect(pickVariantWidth(0)).toBeNull();
    expect(pickVariantWidth(NaN)).toBeNull();
  });

  it('rewrites only our own https media URLs', () => {
    expect(imageVariantUrl(ORIGINAL, 400)).toBe(`${ORIGINAL}.w480.webp`);
    expect(imageVariantUrl(ORIGINAL, 1300)).toBe(ORIGINAL);
    expect(imageVariantUrl('https://pub-abc.r2.dev/dahab/x.webp', 300)).toBe(
      'https://pub-abc.r2.dev/dahab/x.webp.w480.webp'
    );
    for (const foreign of [
      'https://images.unsplash.com/photo-1.jpg',
      'http://media.ebda.app/stores/s/a.jpg',
      'https://media.ebda.app/stores/s/a.svg',
      'https://media.ebda.app/stores/s/a.jpg?v=2',
      'https://media.ebda.app/stores/s/a.jpg.w720.webp',
      '/relative/a.jpg',
      'not a url',
      '',
    ])
      expect(imageVariantUrl(foreign, 400)).toBe(foreign);
  });

  it('builds a full-ladder srcset, or nothing when no variant applies', () => {
    const set = imageVariantSrcSet(ORIGINAL);
    expect(set.split(', ')).toHaveLength(IMAGE_VARIANT_WIDTHS.length + 1);
    expect(set).toContain(`${ORIGINAL}.w480.webp 480w`);
    expect(set).toContain(`${ORIGINAL}.w1280.webp 1280w`);
    // the original is the big-screen candidate
    expect(set.endsWith(`${ORIGINAL} ${IMAGE_ORIGINAL_SRCSET_WIDTH}w`)).toBe(true);
    expect(imageVariantSrcSet('https://cdn.example.com/a.jpg')).toBe('');
  });

  it('undoes a variant URL', () => {
    expect(originalUrlOfVariant(`${ORIGINAL}.w720.webp`)).toBe(ORIGINAL);
    expect(originalUrlOfVariant(ORIGINAL)).toBeNull();
    expect(originalUrlOfVariant('nope')).toBeNull();
  });
});
