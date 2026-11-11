import { describe, it, expect } from 'vitest';
import { visibleToShoppers } from '../../apps/api/src/lib/storefront-categories';

const cat = (id: string, n: number, parentId: string | null = null) => ({ id, n, parentId });

describe('visibleToShoppers (QA-B2)', () => {
  it('hides an empty category and keeps a stocked one', () => {
    const out = visibleToShoppers([cat('default', 0), cat('rings', 3)], c => c.n);
    expect(out.map(c => c.id)).toEqual(['rings']);
  });

  it('keeps an empty parent whose child has products, so the child is not orphaned', () => {
    const out = visibleToShoppers([cat('p', 0), cat('c', 2, 'p'), cat('x', 0)], c => c.n);
    expect(out.map(c => c.id)).toEqual(['p', 'c']);
  });

  it('returns nothing when every category is empty, and survives a parent cycle', () => {
    expect(visibleToShoppers([cat('a', 0), cat('b', 0)], c => c.n)).toEqual([]);
    const cyc = visibleToShoppers([cat('a', 1, 'b'), cat('b', 0, 'a')], c => c.n);
    expect(cyc.map(c => c.id)).toEqual(['a', 'b']);
  });
});
