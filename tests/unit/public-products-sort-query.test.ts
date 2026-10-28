/** `sort` on GET /public/products is a scalar Zod enum at the edge (search PR4 rule). */
import { describe, it, expect } from 'vitest';
import { ZodError } from 'zod/v3';
import {
  parseOptionalSortQuery,
  assertOnSaleQuery,
  PUBLIC_PRODUCT_SORTS,
} from '../../apps/api/src/lib/query-params';

describe('parseOptionalSortQuery', () => {
  it('absent -> undefined; every known value passes through', () => {
    expect(parseOptionalSortQuery(undefined)).toBeUndefined();
    for (const v of PUBLIC_PRODUCT_SORTS) expect(parseOptionalSortQuery(v)).toBe(v);
    expect(PUBLIC_PRODUCT_SORTS).toContain('on_sale');
  });
  it.each([
    ['onsale'],
    ['ON_SALE'],
    [''],
    ['default'],
    [['on_sale', 'newest']],
    [['on_sale']],
    [{ a: 1 }],
    [7],
  ])('rejects %j with a ZodError (-> 400 VALIDATION_ERROR), not "no sort"', value => {
    expect(() => parseOptionalSortQuery(value)).toThrow(ZodError);
  });
  it('the error names the parameter', () => {
    try {
      parseOptionalSortQuery('nope');
    } catch (e) {
      expect((e as ZodError).issues[0].path[0]).toBe('sort');
    }
  });
});

describe('assertOnSaleQuery', () => {
  it('allows category, ids, limit, page, cursor', () => {
    expect(() =>
      assertOnSaleQuery({
        sort: 'on_sale',
        category: 'x',
        ids: 'a,b',
        limit: '12',
        page: '9',
        cursor: 'c',
      })
    ).not.toThrow();
  });
  it.each([['search'], ['minPrice'], ['maxPrice'], ['featured'], ['opt_Color']])(
    'refuses %s with a ZodError',
    key => {
      expect(() => assertOnSaleQuery({ sort: 'on_sale', [key]: 'x' })).toThrow(ZodError);
    }
  );
});
