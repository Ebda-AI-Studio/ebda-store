import { describe, it, expect } from 'vitest';
import { autoSelectVariant, autoSelection } from './single-variant';

const v = (
  inventory: number | null | undefined,
  options: Record<string, string> = { Size: '80g' }
) => ({
  inventory,
  options,
});

describe('autoSelectVariant', () => {
  it('picks the only variant when it is in stock or untracked', () => {
    for (const inv of [5, undefined, null]) {
      const only = v(inv);
      expect(autoSelectVariant([only], ['Size'])).toBe(only);
    }
  });

  it('never picks when there is a choice, nothing to show, or the pill is disabled', () => {
    expect(autoSelectVariant([v(5), v(5, { Size: '1 Kg' })], ['Size'])).toBeNull();
    expect(autoSelectVariant([], ['Size'])).toBeNull();
    expect(autoSelectVariant(undefined, ['Size'])).toBeNull();
    expect(autoSelectVariant([v(0)], ['Size'])).toBeNull(); // sold out
    expect(autoSelectVariant([v(5)], [])).toBeNull(); // no picker rendered
    expect(autoSelectVariant([v(5)], ['Size', 'Color'])).toBeNull(); // axis without a value
  });

  it('autoSelection maps every axis to the variant value', () => {
    expect(autoSelection([v(5, { Size: '80g', Color: 'Red' })], ['Size', 'Color'])).toEqual({
      Size: '80g',
      Color: 'Red',
    });
    expect(autoSelection([v(0)], ['Size'])).toEqual({});
  });
});
