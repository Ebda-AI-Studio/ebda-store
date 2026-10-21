import { describe, it, expect } from 'vitest';
import { pctToBps } from './pct';

describe('pctToBps', () => {
  it('turns a typed percent into basis points', () => {
    expect(pctToBps('12.5')).toBe(1250);
    expect(pctToBps('10')).toBe(1000);
    expect(pctToBps('0')).toBe(0);
    expect(pctToBps('12,5')).toBe(1250);
    expect(pctToBps('90')).toBe(9000);
  });
  it('refuses anything outside 0..90 or with more than two decimals', () => {
    for (const bad of ['', 'abc', '91', '100', '-5', '1.234', '1e2'])
      expect(pctToBps(bad), bad).toBeNull();
  });
});
