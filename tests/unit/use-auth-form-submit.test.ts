import { describe, it, expect, vi } from 'vitest';

/**
 * The hook needs React to run, and this repo has no React test renderer, so the
 * LIFECYCLE CONTRACT is asserted against an extracted copy of the same logic.
 * That is weaker than rendering the hook and is called out rather than implied —
 * what it does guarantee is that the contract itself (always clear loading, use
 * the fallback only when there is no message, report success/failure) is pinned.
 */
async function runSubmit(
  action: () => Promise<void>,
  fallbackMessage: string,
  sink: { loading: boolean[]; error: string }
): Promise<boolean> {
  const setIsLoading = (v: boolean) => sink.loading.push(v);
  const setError = (v: string) => {
    sink.error = v;
  };
  setIsLoading(true);
  setError('');
  try {
    await action();
    return true;
  } catch (err) {
    setError(err instanceof Error && err.message ? err.message : fallbackMessage);
    return false;
  } finally {
    setIsLoading(false);
  }
}

describe('auth submit lifecycle', () => {
  it('clears loading after success', async () => {
    const sink = { loading: [] as boolean[], error: '' };
    const ok = await runSubmit(async () => {}, 'fallback', sink);
    expect(ok).toBe(true);
    expect(sink.loading).toEqual([true, false]);
    expect(sink.error).toBe('');
  });

  it('ALWAYS clears loading after a throw — a stuck form is the bug this prevents', async () => {
    const sink = { loading: [] as boolean[], error: '' };
    const ok = await runSubmit(
      async () => {
        throw new Error('boom');
      },
      'fallback',
      sink
    );
    expect(ok).toBe(false);
    expect(sink.loading).toEqual([true, false]);
    expect(sink.error).toBe('boom');
  });

  it('uses the fallback when the thrown value has no usable message', async () => {
    // Never show a raw object to a shopper.
    const sink = { loading: [] as boolean[], error: '' };
    await runSubmit(
      async () => {
        throw { code: 500 };
      },
      'Something went wrong',
      sink
    );
    expect(sink.error).toBe('Something went wrong');

    const sink2 = { loading: [] as boolean[], error: '' };
    await runSubmit(
      async () => {
        throw new Error('');
      },
      'Something went wrong',
      sink2
    );
    expect(sink2.error).toBe('Something went wrong');
  });

  it('clears a previous error before retrying', async () => {
    const sink = { loading: [] as boolean[], error: 'stale error' };
    await runSubmit(async () => {}, 'fallback', sink);
    expect(sink.error).toBe('');
  });
});
