import { describe, expect, it } from 'vitest';
import { TableDigest, canonRow, canonValue } from '../src/canon.mjs';

describe('canon', () => {
  it('maps values to a type-free text form and keeps NULL apart from the string "null"', () => {
    expect(canonValue(null)).toBeNull();
    expect(canonValue(0)).toBe('0');
    expect(canonValue(1.5)).toBe('1.5');
    expect(canonValue(10n)).toBe('10');
    expect(canonValue('null')).toBe('null');
    expect(canonRow(['a'], [null])).not.toBe(canonRow(['a'], ['null']));
  });
  it('refuses booleans and non-finite numbers (a transform must have produced 0/1 already)', () => {
    expect(() => canonValue(true)).toThrow();
    expect(() => canonValue(Number.NaN)).toThrow();
  });
  it('is column-order independent', () => {
    expect(canonRow(['b', 'a'], [2, 1])).toBe(canonRow(['a', 'b'], [1, 2]));
  });
  it('digests are row-order independent and change when any single cell changes', async () => {
    const cols = ['id', 'name', 'price'];
    const rows = [
      ['a', 'x', 100],
      ['b', 'y', 250],
      ['c', null, 0],
    ];
    const d = async (rs: unknown[][]) => {
      const t = new TableDigest();
      for (const r of rs) await t.add(cols, r, ['id']);
      return t.finish();
    };
    const base = await d(rows);
    expect((await d([...rows].reverse())).digest).toBe(base.digest);
    expect(base.count).toBe(3);
    expect((await d([['a', 'x', 101], rows[1], rows[2]])).digest).not.toBe(base.digest);
    expect((await d([rows[0], rows[1], ['c', 'null', 0]])).digest).not.toBe(base.digest);
    expect((await d(rows.slice(0, 2))).digest).not.toBe(base.digest);
  });
});
