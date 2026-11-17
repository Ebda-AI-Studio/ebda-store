import { describe, expect, it } from 'vitest';
import { ledgerCostsKnown } from './analytics.service';

describe('ledgerCostsKnown (QA 2026-11-17 N1)', () => {
  it('is false when there is revenue and no cost of goods booked', () => {
    expect(ledgerCostsKnown(485000, 0)).toBe(false);
  });
  it('is true once cost of goods is booked', () => {
    expect(ledgerCostsKnown(485000, 1)).toBe(true);
  });
  it('is true for a period with no revenue (nothing to be unknown about)', () => {
    expect(ledgerCostsKnown(0, 0)).toBe(true);
  });
});
