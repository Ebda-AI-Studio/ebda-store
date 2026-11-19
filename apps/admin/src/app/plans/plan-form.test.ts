import { describe, expect, it } from 'vitest';
import { bpsToPercentInput, percentInputToBps } from './plan-form';

describe('plan fee percent <-> bps', () => {
  it('shows bps as a percentage', () => {
    expect(bpsToPercentInput(250)).toBe('2.5');
    expect(bpsToPercentInput(0)).toBe('0');
    expect(bpsToPercentInput(10000)).toBe('100');
    expect(bpsToPercentInput(115)).toBe('1.15');
  });
  it('converts a percentage to bps (x100)', () => {
    expect(percentInputToBps('2.5')).toBe(250);
    expect(percentInputToBps('0')).toBe(0);
    expect(percentInputToBps('100')).toBe(10000);
    expect(percentInputToBps('1,15')).toBe(115);
    expect(percentInputToBps('0.29')).toBe(29);
  });
  it('rejects blank, negative, >100, >2 decimals and junk', () => {
    for (const bad of ['', ' ', '-1', '100.01', '101', '1.234', 'abc', '1e2']) {
      expect(Number.isNaN(percentInputToBps(bad))).toBe(true);
    }
  });
  it('round-trips every stored bps value', () => {
    for (let b = 0; b <= 10000; b += 1) {
      expect(percentInputToBps(bpsToPercentInput(b))).toBe(b);
    }
  });
});
