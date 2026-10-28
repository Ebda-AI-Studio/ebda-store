import { describe, expect, it } from 'vitest';
import { findSurpriseSlug, type SurprisePage } from './surprise-product';

const p = (slug: string, inStock?: boolean, status = 'active') => ({ slug, inStock, status });

describe('findSurpriseSlug', () => {
  it('returns null for a store with no products or a failed probe', async () => {
    expect(await findSurpriseSlug(async () => ({ products: [], total: 0 }))).toBeNull();
    expect(await findSurpriseSlug(async () => null)).toBeNull();
  });

  it('picks only in-stock, active products', async () => {
    const page: SurprisePage = {
      total: 3,
      products: [p('out', false), p('draft', true, 'draft'), p('ok', true)],
    };
    for (const r of [0, 0.4, 0.99])
      expect(
        await findSurpriseSlug(
          async () => page,
          () => r
        )
      ).toBe('ok');
  });

  it('treats a missing inStock flag as in stock (older payload)', async () => {
    expect(await findSurpriseSlug(async () => ({ total: 1, products: [p('legacy')] }))).toBe(
      'legacy'
    );
  });

  it('spreads over pages: a random page is fetched, and an empty one falls back to page 1', async () => {
    const calls: number[] = [];
    const fetchPage = async (page: number): Promise<SurprisePage> => {
      calls.push(page);
      return page === 1
        ? { total: 72, products: [p('first')] }
        : { total: 72, products: [p('sold-out', false)] };
    };
    // random 0.99 -> page 3 (all sold out) -> falls back to page 1's pool
    expect(await findSurpriseSlug(fetchPage, () => 0.99)).toBe('first');
    expect(calls).toEqual([1, 3]);
  });

  it('returns null when everything everywhere is sold out', async () => {
    expect(
      await findSurpriseSlug(async () => ({ total: 2, products: [p('a', false), p('b', false)] }))
    ).toBeNull();
  });
});
