/** STORE-QA-60: "sent empty" must reach the service as null (clear); "not sent" stays undefined (no change). */
import { describe, it, expect } from 'vitest';
import { z } from 'zod/v3';
import { clearableStr, clearableUrl, clearableEmail, clearableSafeUrl } from './clearable-schema';

const schema = z
  .object({
    s: clearableStr(10),
    u: clearableUrl,
    e: clearableEmail,
    l: clearableSafeUrl,
  })
  .strip();

describe('clearable schemas', () => {
  it.each(['', '   ', null])('maps %j to null (clear)', empty => {
    expect(schema.parse({ s: empty, u: empty, e: empty, l: empty })).toEqual({
      s: null,
      u: null,
      e: null,
      l: null,
    });
  });
  it('leaves an absent field undefined (no change)', () => {
    const out = schema.parse({});
    expect(out.s).toBeUndefined();
    expect('s' in out).toBe(false);
  });
  it('still validates real values', () => {
    expect(schema.parse({ s: 'hi', u: 'https://a.co/x.png' })).toMatchObject({ s: 'hi' });
    expect(() => schema.parse({ s: 'x'.repeat(11) })).toThrow();
    expect(() => schema.parse({ u: 'not a url' })).toThrow();
    expect(() => schema.parse({ e: 'nope' })).toThrow();
    expect(() => schema.parse({ l: 'javascript:alert(1)' })).toThrow();
  });
});
