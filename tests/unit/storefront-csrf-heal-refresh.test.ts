/**
 * The storefront's CSRF heal has to reach the server, and has to land on the
 * request that triggered it.
 *
 * #1526 — `refreshAccessToken` bailed out on iOS whenever localStorage held no
 * refresh token. Safari ITP evicts localStorage while the server-set refresh
 * cookie survives, so the common iOS state (cookie alive, localStorage empty)
 * never called /auth/refresh at all: no CSRF token was ever re-minted and every
 * non-/public/ write, POST /payments/create included, 403'd until a re-login.
 *
 * #1528 — a refresh the server REJECTED (401) clears the dead session's
 * cookies, which is exactly what makes the cookieless CSRF branch let a guest
 * write through. But the client read the 401 as `null` and skipped the retry,
 * so the shopper's "Place order" still failed on the attempt that healed it.
 *
 * Both are driven through the real ApiClient against a stubbed fetch.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const ORIGINAL_FETCH = globalThis.fetch;

// localStorage stand-in (same reasoning as refresh-throttle-not-logout.test.ts:
// this repo has no DOM test environment and must not switch to one per file).
function makeLocalStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, String(v)),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: (i: number) => [...map.keys()][i] ?? null,
    get length() {
      return map.size;
    },
  } as unknown as Storage;
}

const store = makeLocalStorage();
const IPHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

function res(status: number, body: unknown = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => body,
    clone() {
      return this;
    },
  } as unknown as Response;
}

const CSRF_403 = { success: false, error: { code: 'CSRF_INVALID', message: 'Invalid CSRF token' } };

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal('localStorage', store);
  vi.stubGlobal('window', { localStorage: store, navigator: { userAgent: IPHONE_UA } });
  vi.stubGlobal('navigator', { userAgent: IPHONE_UA });
  localStorage.clear();
  localStorage.setItem('sessionId', 'sess_test');
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function calls(fetchMock: ReturnType<typeof vi.fn>): string[] {
  return fetchMock.mock.calls.map(c => String(c[0]));
}

describe('iOS shopper with the refresh cookie alive and localStorage evicted (#1526)', () => {
  it('still calls /auth/refresh — with an empty body, so the server reads the cookie', async () => {
    let paymentAttempts = 0;
    const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
      if (String(url).includes('/auth/refresh')) {
        expect(init?.body).toBe('{}');
        return res(200, { success: true, data: { csrfToken: 'fresh-csrf', refreshed: true } });
      }
      paymentAttempts += 1;
      return paymentAttempts === 1 ? res(403, CSRF_403) : res(200, { success: true, data: {} });
    });
    globalThis.fetch = fetchMock as never;
    const { api } = await import('@web/lib/api');

    const result = await api.post('/payments/create', { orderId: 'o1' });

    expect(calls(fetchMock).some(u => u.includes('/auth/refresh'))).toBe(true);
    expect(localStorage.getItem('csrfToken')).toBe('fresh-csrf');
    expect(result.success).toBe(true);
    // The retry carried the re-minted token.
    const retryInit = fetchMock.mock.calls[2][1] as RequestInit;
    expect((retryInit.headers as Record<string, string>)['X-CSRF-Token']).toBe('fresh-csrf');
  });

  // #2148: the refresh route's 400 ("no refresh token presented") now clears
  // any dead `token` cookie that caused the CSRF-403, so it is the same fact
  // as a 401 — the browser is cookieless afterwards and the write is retried
  // ONCE as the guest request it now is. If that retry still 403s it is
  // surfaced, never looped on.
  it('a refresh 400 retries the CSRF-403 once, then surfaces a second 403 without looping', async () => {
    const fetchMock = vi.fn(async (url: unknown) =>
      String(url).includes('/auth/refresh')
        ? res(400, { success: false, error: { code: 'VALIDATION_ERROR' } })
        : res(403, CSRF_403)
    );
    globalThis.fetch = fetchMock as never;
    const { api } = await import('@web/lib/api');

    const result = await api.post('/payments/create', { orderId: 'o1' });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('CSRF_INVALID');
    expect(calls(fetchMock).filter(u => u.includes('/payments/create'))).toHaveLength(2);
    expect(calls(fetchMock).filter(u => u.includes('/auth/refresh'))).toHaveLength(1);
  });
});

describe('a rejected refresh still lets the triggering checkout write through (#1528)', () => {
  it('retries a CSRF-403 once after the refresh 401 cleared the cookies', async () => {
    let paymentAttempts = 0;
    const fetchMock = vi.fn(async (url: unknown) => {
      if (String(url).includes('/auth/refresh')) return res(401, { success: false });
      paymentAttempts += 1;
      // Attempt 1 carried the dead session's cookies → CSRF 403. Attempt 2 is
      // cookieless (the refresh 401 cleared them) → the guest branch admits it.
      return paymentAttempts === 1
        ? res(403, CSRF_403)
        : res(200, { success: true, data: { paymentUrl: 'https://pay' } });
    });
    globalThis.fetch = fetchMock as never;
    const { api } = await import('@web/lib/api');

    const result = await api.post('/payments/create', { orderId: 'o1' });

    expect(result.success).toBe(true);
    expect(paymentAttempts).toBe(2);
  });

  it('retries at most once — a second CSRF-403 is surfaced, not looped on', async () => {
    const fetchMock = vi.fn(async (url: unknown) =>
      String(url).includes('/auth/refresh') ? res(401, { success: false }) : res(403, CSRF_403)
    );
    globalThis.fetch = fetchMock as never;
    const { api } = await import('@web/lib/api');

    const result = await api.post('/payments/create', { orderId: 'o1' });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('CSRF_INVALID');
    expect(calls(fetchMock).filter(u => u.includes('/payments/create'))).toHaveLength(2);
  });

  it('does NOT retry a plain 401 on a rejected refresh — the session is gone', async () => {
    const fetchMock = vi.fn(async (url: unknown) =>
      String(url).includes('/auth/refresh')
        ? res(401, { success: false })
        : res(401, { success: false, error: { code: 'UNAUTHORIZED', message: 'no' } })
    );
    globalThis.fetch = fetchMock as never;
    const { api } = await import('@web/lib/api');

    const result = await api.post('/wishlist', { productId: 'p1' });

    expect(result.success).toBe(false);
    expect(calls(fetchMock).filter(u => u.includes('/wishlist'))).toHaveLength(1);
  });
});
