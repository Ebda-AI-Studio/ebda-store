/** STORE-QA-60: "sent empty" must reach the service as null (clear); "not sent" stays undefined (no change). */
import { describe, it, expect } from 'vitest';
import { z } from 'zod/v3';
import {
  clearableStr,
  clearableUrl,
  clearableEmail,
  clearableSafeUrl,
  clearablePhone,
} from './clearable-schema';

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

describe('clearablePhone (G12 + STORE-QA-60)', () => {
  const p = z.object({ phone: clearablePhone() }).strip();
  it("'' and whitespace clear (null); absent stays absent", () => {
    expect(p.parse({ phone: '' }).phone).toBeNull();
    expect(p.parse({ phone: '   ' }).phone).toBeNull();
    expect('phone' in p.parse({})).toBe(false);
  });
  it('an email or letters are refused, a real number passes', () => {
    expect(p.safeParse({ phone: 'a@b.com' }).success).toBe(false);
    expect(p.safeParse({ phone: 'call me' }).success).toBe(false);
    expect(p.safeParse({ phone: '+201012345678' }).success).toBe(true);
  });
});
