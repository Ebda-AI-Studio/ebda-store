// Ruling B5-7: ?minPrice / ?maxPrice seed the product list's price range.
import { describe, it, expect } from 'vitest';
import { plpUrlPrice } from '../../apps/web/src/lib/plp-url-price';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const q = (s: string) => new URLSearchParams(s);

describe('plpUrlPrice', () => {
  it('reads minor units into major units: ?maxPrice=500000 is EGP 5000', () => {
    expect(plpUrlPrice(q('category=engagement&maxPrice=500000'), 5000)).toEqual({
      min: 0,
      max: 5000,
      sliderMax: 10000,
    });
  });
  it('a cap under the natural ceiling keeps the slider as it was', () => {
    expect(plpUrlPrice(q('maxPrice=100000'), 5000)).toEqual({ min: 0, max: 1000, sliderMax: 5000 });
  });
  it('reads a floor too', () => {
    expect(plpUrlPrice(q('minPrice=100000&maxPrice=300000'), 5000)).toMatchObject({
      min: 1000,
      max: 3000,
    });
  });
  it('ignores junk: negative, zero, float, text, huge, empty', () => {
    for (const bad of ['-1', '0', '1.5', 'abc', '99999999999', ''])
      expect(plpUrlPrice(q(`maxPrice=${bad}&minPrice=${bad}`), 5000)).toEqual({
        min: 0,
        max: 0,
        sliderMax: 5000,
      });
  });
  it('the cap is a real restriction: it is below the widened slider ceiling (so the API param is sent)', () => {
    const r = plpUrlPrice(q('maxPrice=500000'), 5000);
    expect(r.max).toBeLessThan(r.sliderMax);
  });
  it('the list sends maxPrice only below the slider ceiling and clear-all restores the ceiling', () => {
    const src = readFileSync(
      path.resolve(__dirname, '../../apps/web/src/app/products/ProductsClient.tsx'),
      'utf8'
    );
    expect(src).toContain('if (priceMax < sliderMax) params.maxPrice');
    expect(src).toContain('setPriceMax(sliderMax)');
    // PL1: the natural ceiling is the catalogue's real highest price, not a fixed 5,000
    expect(src).toContain('plpUrlPrice(searchParams, priceSliderCeil(initialMeta?.priceMax))');
  });
});
