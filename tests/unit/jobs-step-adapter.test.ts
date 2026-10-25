import { describe, it, expect, vi } from 'vitest';
import {
  durableStep,
  inlineStep,
  isNonRetriable,
  normaliseResult,
  parseDurationMs,
  MAX_STEP_RESULT_BYTES,
  type WorkflowStepLike,
} from '@api/lib/jobs/step-adapter';

class NonRetryable extends Error {}

function fakeWf() {
  const calls: Array<[string, string, unknown?]> = [];
  const wf: WorkflowStepLike = {
    async do(name, cfg, cb) {
      calls.push(['do', name, cfg]);
      return cb();
    },
    async sleep(name, d) {
      calls.push(['sleep', name, d]);
    },
    async sleepUntil(name, ts) {
      calls.push(['sleepUntil', name, ts]);
    },
  };
  return { wf, calls };
}

const mk = (wf: WorkflowStepLike, extra: Partial<Parameters<typeof durableStep>[1]> = {}) =>
  durableStep(wf, {
    retries: 3,
    withContext: fn => fn(),
    dispatch: async () => undefined,
    NonRetryable,
    ...extra,
  });

describe('parseDurationMs', () => {
  it.each([
    ['30s', 30_000],
    ['5m', 300_000],
    ['2h', 7_200_000],
    ['1d', 86_400_000],
    ['250ms', 250],
    ['10 seconds', 10_000],
    ['15 minutes', 900_000],
    [1500, 1500],
  ])('%s', (d, ms) => expect(parseDurationMs(d)).toBe(ms));
  it('rejects nonsense', () => expect(() => parseDurationMs('soon')).toThrow());
});

describe('normaliseResult (what a replayed Inngest step returned)', () => {
  it('Dates become strings, undefined becomes null, objects are copied', () => {
    const d = new Date('2026-01-01T00:00:00Z');
    expect(normaliseResult({ d, x: undefined, n: 1 })).toEqual({ d: d.toISOString(), n: 1 });
    expect(normaliseResult(undefined)).toBeNull();
  });
  it('a result over the per-step limit is a NonRetriableError, not a silent truncation', () => {
    const big = 'x'.repeat(MAX_STEP_RESULT_BYTES + 10);
    try {
      normaliseResult(big);
      throw new Error('should have thrown');
    } catch (e) {
      expect(isNonRetriable(e)).toBe(true);
    }
  });
});

describe('durableStep', () => {
  it('step.run is one Workflow step with the function retries and exponential backoff', async () => {
    const { wf, calls } = fakeWf();
    const step = mk(wf, { retries: 2 });
    const out = await step.run('load', async () => ({ a: 1 }));
    expect(out).toEqual({ a: 1 });
    expect(calls[0]).toEqual([
      'do',
      'load',
      { retries: { limit: 2, delay: '10 seconds', backoff: 'exponential' }, timeout: '15 minutes' },
    ]);
  });

  it('a name used twice (a loop) becomes name, name#2, name#3, stable across replays', async () => {
    const run = async () => {
      const { wf, calls } = fakeWf();
      const step = mk(wf);
      for (let i = 0; i < 3; i++) await step.run('batch', async () => i);
      return calls.map(c => c[1]);
    };
    expect(await run()).toEqual(['batch', 'batch#2', 'batch#3']);
    expect(await run()).toEqual(['batch', 'batch#2', 'batch#3']);
  });

  it('every body runs inside the Worker context wrapper', async () => {
    const { wf } = fakeWf();
    const withContext = vi.fn(async <T>(fn: () => Promise<T>) => fn());
    await mk(wf, { withContext }).run('s', async () => 1);
    expect(withContext).toHaveBeenCalledTimes(1);
  });

  it('NonRetriableError becomes the Workflows NonRetryableError (no pointless retries)', async () => {
    const { wf } = fakeWf();
    const err = Object.assign(new Error('bad input'), { name: 'NonRetriableError' });
    await expect(mk(wf).run('s', async () => Promise.reject(err))).rejects.toBeInstanceOf(
      NonRetryable
    );
  });

  it('any other error propagates as-is so the step retries', async () => {
    const { wf } = fakeWf();
    await expect(mk(wf).run('s', async () => Promise.reject(new Error('flaky')))).rejects.toThrow(
      'flaky'
    );
  });

  it('sleep and sleepUntil are real Workflow sleeps with milliseconds', async () => {
    const { wf, calls } = fakeWf();
    const step = mk(wf);
    await step.sleep('wait', '5m');
    await step.sleepUntil('until', '2026-01-01T00:00:00Z');
    expect(calls).toEqual([
      ['sleep', 'wait', 300_000],
      ['sleepUntil', 'until', new Date('2026-01-01T00:00:00Z')],
    ]);
  });

  it('sendEvent is a durable step: dispatched once, not on replay', async () => {
    const { wf, calls } = fakeWf();
    const dispatch = vi.fn(async () => undefined);
    await mk(wf, { dispatch }).sendEvent('fan', { name: 'x/y', data: { a: 1 } });
    expect(dispatch).toHaveBeenCalledWith({ name: 'x/y', data: { a: 1 } });
    expect(calls[0]![0]).toBe('do');
    expect(calls[0]![1]).toBe('fan');
  });
});

describe('inlineStep (queue runtime)', () => {
  it('runs the step body and normalises, sleeps are refused', async () => {
    const step = inlineStep({ dispatch: async () => undefined });
    expect(await step.run('a', async () => ({ d: new Date(0) }))).toEqual({
      d: '1970-01-01T00:00:00.000Z',
    });
    await expect(step.sleep('s', '1m')).rejects.toThrow(/queue runtime/);
  });
});
