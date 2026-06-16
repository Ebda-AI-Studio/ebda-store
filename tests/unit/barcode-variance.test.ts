/**
 * Barcode Variance Computation — Unit Tests
 *
 * Validates the variance arithmetic used by the cycle-count reconcile path.
 * variance = countedQty - systemQty
 *   positive  → more stock found than expected
 *   negative  → stock missing vs system
 *   zero      → counts match, no adjustment needed
 */

import { describe, it, expect } from 'vitest';

// Pure helper that mirrors the variance logic in submitCountLine
function computeVariance(countedQty: number, systemQty: number): number {
  return countedQty - systemQty;
}

describe('barcode variance computation', () => {
  it('returns 0 when counted matches system', () => {
    expect(computeVariance(10, 10)).toBe(0);
  });

  it('returns a positive number when counted > system (surplus)', () => {
    expect(computeVariance(15, 10)).toBe(5);
  });

  it('returns a negative number when counted < system (shrinkage)', () => {
    expect(computeVariance(8, 10)).toBe(-2);
  });

  it('handles zero counted quantity (full shrinkage)', () => {
    expect(computeVariance(0, 10)).toBe(-10);
  });

  it('handles zero system quantity (untracked stock found)', () => {
    expect(computeVariance(5, 0)).toBe(5);
  });

  it('handles large values without overflow', () => {
    expect(computeVariance(100_000, 99_999)).toBe(1);
    expect(computeVariance(0, 100_000)).toBe(-100_000);
  });

  it('variance for lines to reconcile is every non-zero variance line', () => {
    const lines = [
      { countedQty: 10, systemQty: 10 }, // 0 — skip
      { countedQty: 12, systemQty: 10 }, // +2 — include
      { countedQty: 5, systemQty: 8 }, // -3 — include
      { countedQty: 3, systemQty: 3 }, // 0 — skip
    ].map(l => ({ ...l, variance: computeVariance(l.countedQty, l.systemQty) }));

    const nonZeroLines = lines.filter(l => l.variance !== 0);
    expect(nonZeroLines.length).toBe(2);
    expect(nonZeroLines.map(l => l.variance)).toEqual([2, -3]);
  });
});
