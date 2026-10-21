/**
 * Task 12 review M6: the in-page search on /products receives the hybrid relevance order when the
 * server ranked it (`meta.ranked`). Its default option then says "Most relevant" / "الأكثر صلة",
 * not "Recommended"; unranked lists keep "Recommended" (the merchant's order), unchanged.
 */
import { describe, it, expect } from 'vitest';
import { getSortOptions } from './products-sort';

const en = (e: string) => e;
const ar = (_e: string, a: string) => a;

describe('/products sort options (Task 12)', () => {
  it('unranked: the default option is "Recommended", as before', () => {
    expect(getSortOptions(en, false)[0]).toEqual({ value: 'default', label: 'Recommended' });
    expect(getSortOptions(ar, false)[0].label).toBe('المُوصى به');
  });
  it('ranked: the same default option reads "Most relevant" / "الأكثر صلة"', () => {
    expect(getSortOptions(en, true)[0]).toEqual({ value: 'default', label: 'Most relevant' });
    expect(getSortOptions(ar, true)[0].label).toBe('الأكثر صلة');
  });
  it('the other options are unchanged', () => {
    expect(getSortOptions(en, true).slice(1)).toEqual(getSortOptions(en, false).slice(1));
    expect(getSortOptions(en, false).map(o => o.value)).toEqual([
      'default',
      'featured',
      'newest',
      'best_seller',
      'price-asc',
      'price-desc',
    ]);
  });
});
