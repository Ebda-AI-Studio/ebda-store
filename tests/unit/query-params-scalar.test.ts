/**
 * M1 (Task 12 review): listing/search query params must be ONE string at the edge. `qs` turns
 * `?a[b]=c` into an object (a Prisma operator once cast) and `?a=1&a=2` into an array (a 500).
 */
import { describe, it, expect } from 'vitest';
import { ZodError } from 'zod/v3';
import { assertScalarQuery } from '../../apps/api/src/lib/query-params';

describe('assertScalarQuery', () => {
  it('passes strings, absent keys and unlisted keys', () => {
    expect(() =>
      assertScalarQuery({ category: 'shoes', other: ['x'] }, ['category'])
    ).not.toThrow();
    expect(() => assertScalarQuery({}, ['category'])).not.toThrow();
  });
  it('rejects arrays and objects on listed keys and prefixed keys', () => {
    for (const q of [
      { category: ['a', 'b'] },
      { category: { startsWith: 'x' } },
      { opt_Size: ['S'] },
      { opt_Size: { equals: 'S' } },
    ])
      expect(() => assertScalarQuery(q, ['category'], ['opt_'])).toThrow(ZodError);
  });
  it('names every offending key', () => {
    try {
      assertScalarQuery({ status: ['a'], productId: { in: ['x'] } }, ['status', 'productId']);
      throw new Error('did not throw');
    } catch (e) {
      expect((e as ZodError).issues.map(i => i.path[0]).sort()).toEqual(['productId', 'status']);
    }
  });
});
