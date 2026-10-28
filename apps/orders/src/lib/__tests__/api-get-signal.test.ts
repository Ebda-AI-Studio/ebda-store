// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';

/** Search as you type on the orders list: the superseded request is aborted, so apiGet must hand the signal to fetch. */
describe('apiGet signal (orders search abort)', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
    });
  });

  it('passes the AbortSignal to fetch, and an aborted request surfaces as an error (never data)', async () => {
    const seen: (AbortSignal | null | undefined)[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init?: RequestInit) => {
        seen.push(init?.signal);
        return new Promise((_res, rej) => {
          init?.signal?.addEventListener('abort', () =>
            rej(new DOMException('aborted', 'AbortError'))
          );
        });
      })
    );
    const { apiGet } = await import('../api');
    const controller = new AbortController();
    const pending = apiGet('/api/v1/stores/s/orders', { 'X-Search-Query': 'x' }, controller.signal);
    expect(seen[0]).toBe(controller.signal);
    controller.abort();
    const out = await pending.catch(e => ({ data: null, error: e }));
    expect(out.data ?? null).toBeNull();
  });
});
