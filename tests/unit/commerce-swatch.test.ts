import { describe, it, expect } from 'vitest';
import { swatchHexSchema, swatchOf, optionValueSwatchSchema } from '@ebda/shared';

describe('swatch', () => {
  it('accepts #RRGGBB only', () => {
    expect(swatchHexSchema.safeParse('#1F4E54').success).toBe(true);
    expect(swatchHexSchema.safeParse('1F4E54').success).toBe(false);
    expect(swatchHexSchema.safeParse('#fff').success).toBe(false);
    expect(swatchHexSchema.safeParse('red').success).toBe(false);
  });
  it('swatchOf returns null when both empty', () => {
    expect(swatchOf({})).toBeNull();
    expect(swatchOf({ swatchHex: null, swatchImageUrl: '' })).toBeNull();
  });
  it('swatchOf keeps image and hex', () => {
    expect(swatchOf({ swatchHex: '#000000', swatchImageUrl: 'https://x.r2.dev/a.webp' })).toEqual({
      hex: '#000000',
      imageUrl: 'https://x.r2.dev/a.webp',
    });
  });
  it('swatchImageUrl accepts https only', () => {
    const ok = (u: string) => optionValueSwatchSchema.safeParse({ swatchImageUrl: u }).success;
    expect(ok('https://pub-x.r2.dev/a.webp')).toBe(true);
    expect(ok('javascript:alert(1)')).toBe(false);
    expect(ok('data:image/png;base64,xx')).toBe(false);
    expect(ok('http://x.com/a.png')).toBe(false);
    expect(() => ok('not a url')).not.toThrow();
    expect(ok('not a url')).toBe(false);
  });
});
