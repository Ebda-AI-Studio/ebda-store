import { describe, it, expect } from 'vitest';
import { retailUnitPrice } from '../cart-pricing';

describe('retailUnitPrice', () => {
  it('charges the CHOSEN variant price, not the parent product price', () => {
    // The bug: a variant line was priced at product.price (the lowest/base),
    // so picking a pricier variant still charged the cheapest.
    expect(retailUnitPrice({ variant: { price: 4500 }, product: { price: 2000 } })).toBe(4500);
  });

  it('falls back to the product price for variant-less products', () => {
    expect(retailUnitPrice({ variant: null, product: { price: 2000 } })).toBe(2000);
    expect(retailUnitPrice({ product: { price: 3000 } })).toBe(3000);
  });

  it('falls back to the product price when the variant has no price', () => {
    expect(retailUnitPrice({ variant: { price: null }, product: { price: 2500 } })).toBe(2500);
    expect(retailUnitPrice({ variant: {}, product: { price: 2500 } })).toBe(2500);
  });

  it('keeps a genuinely free variant at 0 (nullish-coalescing, not ||)', () => {
    expect(retailUnitPrice({ variant: { price: 0 }, product: { price: 2000 } })).toBe(0);
  });
});
