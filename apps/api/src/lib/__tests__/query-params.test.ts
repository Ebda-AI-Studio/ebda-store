import { describe, it, expect } from 'vitest';
import { ZodError } from 'zod/v3';
import { optionalBooleanQuery, parseOptionalBooleanQuery } from '../query-params';

describe('optionalBooleanQuery', () => {
  it('maps absent to undefined (no filter), not false', () => {
    expect(optionalBooleanQuery.parse(undefined)).toBeUndefined();
    expect(parseOptionalBooleanQuery(undefined, 'featured')).toBeUndefined();
  });

  it("maps 'true' to true and 'false' to false", () => {
    expect(parseOptionalBooleanQuery('true', 'featured')).toBe(true);
    expect(parseOptionalBooleanQuery('false', 'featured')).toBe(false);
  });

  it.each(['', '1', '0', 'yes', 'TRUE', 'False', ['true', 'true'], { a: 'b' }])(
    'rejects %j with a ZodError naming the param',
    value => {
      expect(() => parseOptionalBooleanQuery(value, 'featured')).toThrow(ZodError);
      try {
        parseOptionalBooleanQuery(value, 'featured');
      } catch (err) {
        expect((err as ZodError).issues[0].path[0]).toBe('featured');
      }
    }
  );
});
