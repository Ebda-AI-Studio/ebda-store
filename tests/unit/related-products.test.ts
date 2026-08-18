import { describe, it, expect } from 'vitest';
import { firstCategoryId, pickRelated } from '../../apps/web/src/lib/related-products';

describe('firstCategoryId', () => {
  it('returns the first category id', () => {
    expect(firstCategoryId([{ category: { id: 'c1' } }, { category: { id: 'c2' } }])).toBe('c1');
  });

  it('returns null for every shape that means "no category"', () => {
    // null is the signal to SKIP the related fetch rather than call the API
    // with an undefined category.
    expect(firstCategoryId(undefined)).toBeNull();
    expect(firstCategoryId(null)).toBeNull();
    expect(firstCategoryId([])).toBeNull();
    expect(firstCategoryId([{ category: null }])).toBeNull();
    expect(firstCategoryId([{}])).toBeNull();
    expect(firstCategoryId([{ category: { id: '' } }])).toBeNull();
  });
});

describe('pickRelated', () => {
  const p = (id: string) => ({ id });

  it('excludes the product being viewed', () => {
    // The API filters by category, so the current product is almost always in
    // its own related list — showing it there reads as a bug.
    expect(pickRelated([p('self'), p('a'), p('b')], 'self').map(x => x.id)).toEqual(['a', 'b']);
  });

  it('caps at the limit', () => {
    expect(pickRelated([p('a'), p('b'), p('c'), p('d')], 'self')).toHaveLength(3);
    expect(pickRelated([p('a'), p('b'), p('c'), p('d')], 'self', 2)).toHaveLength(2);
  });

  it('handles missing input without throwing', () => {
    expect(pickRelated(undefined, 'self')).toEqual([]);
    expect(pickRelated(null, 'self')).toEqual([]);
  });

  it('returns empty when the only result is the product itself', () => {
    expect(pickRelated([p('self')], 'self')).toEqual([]);
  });
});

// isOnSale lives in product-pricing but is asserted here alongside the other
// product-detail rules it sits next to.
import { isOnSale } from '../../apps/web/src/lib/product-pricing';

describe('isOnSale', () => {
  it('is true only when compareAtPrice exceeds price', () => {
    expect(isOnSale({ price: 100, compareAtPrice: 150 })).toBe(true);
  });

  it('is false when compareAtPrice EQUALS price — that is not a sale', () => {
    expect(isOnSale({ price: 100, compareAtPrice: 100 })).toBe(false);
  });

  it('is false when compareAtPrice is below price', () => {
    expect(isOnSale({ price: 100, compareAtPrice: 50 })).toBe(false);
  });

  it('is false for missing, null or zero compareAtPrice', () => {
    expect(isOnSale({ price: 100 })).toBe(false);
    expect(isOnSale({ price: 100, compareAtPrice: null })).toBe(false);
    expect(isOnSale({ price: 100, compareAtPrice: 0 })).toBe(false);
  });

  it('narrows compareAtPrice to a number for the caller', () => {
    // The type predicate is the point: without it every call site re-asserts.
    const p = { price: 100, compareAtPrice: 150 as number | undefined };
    if (isOnSale(p)) {
      const compare: number = p.compareAtPrice;
      expect(compare).toBe(150);
    } else {
      throw new Error('expected on sale');
    }
  });
});
