// @vitest-environment jsdom
/** The guest probe (#885) can answer 200 `{ user: null }`: that is a guest, never a session. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from './api';

const KEY = 'hadSession';
const mem = new Map<string, string>();
const answer = (data: unknown) =>
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => ({ success: true, data }),
    }))
  );

beforeEach(() => {
  mem.clear();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => void mem.set(k, v),
    removeItem: (k: string) => void mem.delete(k),
  });
  api.setStoreId('11111111-1111-4111-8111-111111111111');
});
afterEach(() => vi.unstubAllGlobals());

describe('api.getProfile with a guest answer', () => {
  it('{user:null} does not arm the session marker and does not throw', async () => {
    answer({ user: null });
    const res = await api.getProfile();
    expect(res.success).toBe(true);
    expect(res.data?.user).toBeNull();
    expect(mem.has(KEY)).toBe(false);
  });
  it('a real user arms the marker', async () => {
    answer({ user: { id: 'u1', role: 'customer' } });
    await api.getProfile();
    expect(mem.get(KEY)).toBe('1');
  });
});
