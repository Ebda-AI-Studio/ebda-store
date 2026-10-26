import { describe, expect, it } from 'vitest';
import { productsCanonicalPath } from './page';

describe('products listing canonical path (audit M-169)', () => {
  it('plain, sorted and paged listings canonicalise to /products', () => {
    expect(productsCanonicalPath({})).toBe('/products');
    expect(productsCanonicalPath({ sort: 'price', page: '3' })).toBe('/products');
  });
  it('a category or tag filter is its own page', () => {
    expect(productsCanonicalPath({ category: 'abayas', sort: 'price' })).toBe(
      '/products?category=abayas'
    );
    expect(productsCanonicalPath({ tag: 'dry skin' })).toBe('/products?tag=dry%20skin');
  });
  it('the first value of a repeated param wins; blank is ignored', () => {
    expect(productsCanonicalPath({ category: ['a', 'b'] })).toBe('/products?category=a');
    expect(productsCanonicalPath({ category: '  ' })).toBe('/products');
  });
});
