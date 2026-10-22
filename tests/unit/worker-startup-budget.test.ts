import { describe, expect, it } from 'vitest';
import { activeMs, budgetProblems, median } from '../../scripts/ci/worker-startup-budget.mjs';
import budget from '../../scripts/ci/worker-startup-budget.json';

const ok = { startupCpuMs: 90, bundleBytes: 14_244_673, bundleGzipBytes: 3_020_756 };

describe('API Worker startup budget verdict', () => {
  it('the recorded post-fix baseline passes', () => {
    expect(budgetProblems(ok, budget)).toEqual([]);
  });
  it('the pre-fix startup CPU (164 ms) fails', () => {
    expect(budgetProblems({ ...ok, startupCpuMs: 164 }, budget)).toHaveLength(1);
  });
  it('each metric fails on its own', () => {
    expect(budgetProblems({ ...ok, bundleBytes: budget.bundleBytes + 1 }, budget)).toHaveLength(1);
    expect(
      budgetProblems({ ...ok, bundleGzipBytes: budget.bundleGzipBytes + 1 }, budget)
    ).toHaveLength(1);
  });
  it('a missing measurement (NaN) never passes', () => {
    expect(budgetProblems({ ...ok, startupCpuMs: NaN }, budget)).toHaveLength(1);
  });
  it('activeMs sums every sample except (idle)', () => {
    const profile = {
      nodes: [
        { id: 1, callFrame: { functionName: '(idle)' } },
        { id: 2, callFrame: { functionName: 'x' } },
      ],
      samples: [1, 2, 2, 1],
      timeDeltas: [5000, 1000, 2000, 7000],
    };
    expect(activeMs(profile)).toBe(3);
  });
  it('median of odd and even sets', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
  });
});
