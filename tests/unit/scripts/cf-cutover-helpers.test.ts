import { describe, expect, it } from 'vitest';
// @ts-expect-error plain .mjs
import { countsByTable } from '../../../scripts/cf/lib/counts.mjs';
// @ts-expect-error plain .mjs
import { decodeKeychainOutput } from '../../../scripts/cf/lib/keychain.mjs';

describe('countsByTable', () => {
  it('pairs counts with the table the statement was issued for, whatever order another list uses', () => {
    const tables = ['plans', 'billing_events', 'store_subscriptions'];
    const results = [[{ n: 7 }], [{ n: 0 }], [{ n: 3 }]];
    const c = countsByTable(tables, results);
    // plan/FK order differs from the family list: lookup by name, never by index
    const planOrder = ['store_subscriptions', 'billing_events', 'plans'];
    expect(planOrder.map(t => [t, c[t]])).toEqual([
      ['store_subscriptions', 3],
      ['billing_events', 0],
      ['plans', 7],
    ]);
  });
  it('throws when the result count differs from the table count', () => {
    expect(() => countsByTable(['a', 'b'], [[{ n: 1 }]])).toThrow();
  });
});

describe('decodeKeychainOutput', () => {
  const key = '# created\nAGE-SECRET-KEY-1ABCDEF\n';
  const hex = Buffer.from(key).toString('hex');
  it('decodes the hex macOS prints for a multi-line secret', () => {
    expect(decodeKeychainOutput(hex + '\n', /^AGE-SECRET-KEY-1|\n/)).toBe(key.trim());
    expect(decodeKeychainOutput(hex)).toBe(key.trim());
  });
  it('decodes a single-line expected secret', () => {
    const h = Buffer.from('AGE-SECRET-KEY-1XYZ').toString('hex');
    expect(decodeKeychainOutput(h, /^AGE-SECRET-KEY-1/)).toBe('AGE-SECRET-KEY-1XYZ');
  });
  it('leaves plain text and a genuine hex token alone', () => {
    expect(decodeKeychainOutput('AGE-SECRET-KEY-1ABC\n')).toBe('AGE-SECRET-KEY-1ABC');
    expect(decodeKeychainOutput('deadbeefcafe0123', /^AGE-SECRET-KEY-1/)).toBe('deadbeefcafe0123');
    expect(decodeKeychainOutput('abc')).toBe('abc'); // odd length
  });
});
