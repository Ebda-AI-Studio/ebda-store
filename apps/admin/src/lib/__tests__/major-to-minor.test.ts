import { describe, it, expect } from 'vitest';
import { majorToMinor } from '../format';

describe('majorToMinor', () => {
  it.each([
    ['12', 1200],
    ['12.5', 1250],
    ['0.25', 25],
    ['0.29', 29], // parseFloat('0.29') * 100 === 28.999999999999996
    ['1.05', 105],
    ['199.99', 19_999],
    ['  3.1 ', 310],
    ['١٢٫٥', 1250], // Arabic-Indic digits + Arabic decimal separator
    ['12,5', 1250],
    ['1.500', 150], // trailing zeros beyond 2 decimals lose nothing
    ['0', 0],
  ])('%j → %d piastres', (input, piastres) => {
    expect(majorToMinor(input)).toBe(piastres);
  });

  it.each(['', '.', 'abc', '-1', '1.999', '1.2345', '1e3', '12.5.1', '0x10'])(
    'rejects %j',
    input => {
      expect(majorToMinor(input)).toBeNull();
    }
  );
});
