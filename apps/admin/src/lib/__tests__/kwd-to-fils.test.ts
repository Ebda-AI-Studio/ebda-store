import { describe, it, expect } from 'vitest';
import { kwdToFils } from '../format';

describe('kwdToFils', () => {
  it.each([
    ['12', 12_000],
    ['12.5', 12_500],
    ['0.250', 250],
    ['0.29', 290], // parseFloat('0.29') * 1000 === 289.99999999999994
    ['1.005', 1005],
    ['  3.1 ', 3100],
    ['١٢٫٥', 12_500], // Arabic-Indic digits + Arabic decimal separator
    ['12,5', 12_500],
    ['0', 0],
  ])('%j → %d fils', (input, fils) => {
    expect(kwdToFils(input)).toBe(fils);
  });

  it.each(['', '.', 'abc', '-1', '1.2345', '1e3', '12.5.1', '0x10'])('rejects %j', input => {
    expect(kwdToFils(input)).toBeNull();
  });
});
