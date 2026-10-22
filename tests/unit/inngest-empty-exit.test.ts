/**
 * stepRunUnlessEmpty (Ruling INNGEST-BUDGET-1): an empty tick must cost ONE Inngest execution
 * (the run), not run + step. Executions = runs x (steps + 1).
 */
import { describe, it, expect, vi } from 'vitest';
import { stepRunUnlessEmpty } from '@api/lib/inngest/empty-exit';

const countingStep = () => {
  const run = vi.fn(async <T>(_id: string, fn: () => Promise<T>) => fn());
  return { run };
};

describe('stepRunUnlessEmpty', () => {
  it('empty read: returns [] and never opens a step', async () => {
    const step = countingStep();
    const read = vi.fn(async () => [] as number[]);
    expect(await stepRunUnlessEmpty(step, 'find', read)).toEqual([]);
    expect(step.run).not.toHaveBeenCalled();
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('non-empty read: memoises through exactly one step.run and returns its result', async () => {
    const step = countingStep();
    const read = vi.fn(async () => [1, 2]);
    expect(await stepRunUnlessEmpty(step, 'find', read)).toEqual([1, 2]);
    expect(step.run).toHaveBeenCalledTimes(1);
    expect(step.run.mock.calls[0]![0]).toBe('find');
  });

  it('a sync read works too', async () => {
    const step = countingStep();
    expect(await stepRunUnlessEmpty(step, 'find', () => [])).toEqual([]);
    expect(step.run).not.toHaveBeenCalled();
  });
});
