/**
 * Search program Task 12: the search page's default sort is "keep the server's order". With
 * semantic search off the server is not ranking (no `meta.ranked`), so the page must look and sort
 * exactly as before (newest first, "Newest" selected, no "Most relevant" option).
 */
import { describe, it, expect } from 'vitest';
import type { Product } from '@/lib/api';
import { displaySort, getSortOptions, sortProducts } from './search-sort';

const t = (en: string) => en;
const rows = [
  { id: 'old', price: 3, name: 'b', createdAt: '2026-01-01T00:00:00Z' },
  { id: 'new', price: 1, name: 'c', createdAt: '2026-01-03T00:00:00Z' },
  { id: 'mid', price: 2, name: 'a', createdAt: '2026-01-02T00:00:00Z' },
] as unknown as Product[];
const ids = (ps: Product[]) => ps.map(p => p.id);

describe('search page sort (Task 12)', () => {
  it('unranked list: the default reads and sorts as Newest, exactly as before', () => {
    expect(displaySort('relevance', false)).toBe('newest');
    expect(ids(sortProducts(rows, displaySort('relevance', false)))).toEqual(['new', 'mid', 'old']);
    expect(getSortOptions(t, false).map(o => o.value)).toEqual([
      'newest',
      'price-asc',
      'price-desc',
      'name-asc',
    ]);
  });

  it('ranked list: the default keeps the server order and offers "Most relevant" first', () => {
    expect(displaySort('relevance', true)).toBe('relevance');
    expect(ids(sortProducts(rows, 'relevance'))).toEqual(['old', 'new', 'mid']);
    const opts = getSortOptions(t, true);
    expect(opts[0]).toEqual({ value: 'relevance', label: 'Most relevant' });
  });

  it('an explicit sort still wins over the server order', () => {
    expect(displaySort('price-asc', true)).toBe('price-asc');
    expect(ids(sortProducts(rows, 'price-asc'))).toEqual(['new', 'mid', 'old']);
  });

  it('the Arabic label comes from the storefront translations map', () => {
    const ar = (_en: string, a: string) => a;
    expect(getSortOptions(ar, true)[0].label).toBe('الأكثر صلة');
  });
});
