import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_FETCH_TIMEOUT_MS,
  fetchWithTimeout,
  LLM_FETCH_TIMEOUT_MS,
} from '@api/lib/fetch-timeout';

afterEach(() => vi.unstubAllGlobals());

/** A fetch that never answers on its own and rejects when its signal aborts. */
function hangingFetch() {
  return vi.fn(
    (_input: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
      })
  );
}

describe('fetchWithTimeout', () => {
  it('defaults are sane', () => {
    expect(DEFAULT_FETCH_TIMEOUT_MS).toBe(15_000);
    expect(LLM_FETCH_TIMEOUT_MS).toBeGreaterThan(DEFAULT_FETCH_TIMEOUT_MS);
  });

  it('always hands fetch a signal, and strips timeoutMs from the init', async () => {
    const f = vi.fn(async () => new Response('ok'));
    vi.stubGlobal('fetch', f);
    await fetchWithTimeout('https://x.test/a', { method: 'POST', timeoutMs: 5000 });
    const init = (f.mock.calls[0] as unknown as [string, Record<string, unknown>])[1];
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.method).toBe('POST');
    expect('timeoutMs' in init).toBe(false);
  });

  it('rejects with a TimeoutError when the provider never answers (per-call override)', async () => {
    vi.stubGlobal('fetch', hangingFetch());
    const err = await fetchWithTimeout('https://x.test/slow', { timeoutMs: 20 }).catch(e => e);
    expect(err).toMatchObject({ name: 'TimeoutError' });
  });

  it('honours a caller signal as well: whichever fires first wins', async () => {
    vi.stubGlobal('fetch', hangingFetch());
    const ctl = new AbortController();
    const p = fetchWithTimeout('https://x.test/slow', { signal: ctl.signal, timeoutMs: 10_000 });
    ctl.abort(new Error('caller gave up'));
    await expect(p).rejects.toThrow('caller gave up');
  });

  it('a prompt answer is returned untouched', async () => {
    vi.stubGlobal('fetch', async () => new Response('fine', { status: 201 }));
    const res = await fetchWithTimeout('https://x.test/ok');
    expect(res.status).toBe(201);
  });
});
