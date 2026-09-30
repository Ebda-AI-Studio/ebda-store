/**
 * An anonymous storefront visitor must never post `/auth/refresh`.
 *
 * `AuthContext.refreshUser()` runs on EVERY mount and calls `/auth/me`, and
 * request() refreshes on a 401 there (#1789). For a first-time visitor that
 * 401 is the normal answer, so the refresh-on-401 rule turned every guest page
 * load into a credential-less `POST /auth/refresh`. `refreshLimiterKey` buckets
 * a request with no verifiable token as the SHARED `<ip>-refresh-anon` key
 * (120/15min) beneath an IP-wide backstop (600/15min), and express-rate-limit
 * counts the request before the route answers 400 — so guest browsing behind a
 * Kuwait carrier CGNAT or a mall/office wifi exhausts the bucket and the real
 * signed-in customers on that IP start getting 429 on the route that renews
 * their access token and re-mints their CSRF token.
 *
 * The fix gates the 401-refresh on evidence a session ever existed in this
 * browser. These tests pin both directions: no evidence → no refresh; evidence
 * → the #1789 recovery still happens.
 *
 * Since issue 2164 one evidence-free `/auth/me` probe per TAB is allowed (the
 * Safari-ITP cohort), keyed on sessionStorage. These tests stub no
 * sessionStorage, so they pin the no-probe budget; the per-tab cap is pinned in
 * storefront-session-refresh-gates.test.ts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const ORIGINAL_FETCH = globalThis.fetch;

// localStorage stand-in — same reasoning as refresh-throttle-not-logout.test.ts:
// this repo has no DOM test environment and must not switch to one per file.
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

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal('localStorage', store);
  vi.stubGlobal('window', { localStorage: store, navigator: { userAgent: 'node' } });
  vi.stubGlobal('navigator', { userAgent: 'node' });
  localStorage.clear();
  // A session id is minted for every visitor, signed in or not — it is not
  // evidence of a session and must not be read as any.
  localStorage.setItem('sessionId', 'sess_test');
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function refreshCalls(fetchMock: ReturnType<typeof vi.fn>): string[] {
  return fetchMock.mock.calls.map(c => String(c[0])).filter(u => u.includes('/auth/refresh'));
}

describe('guest mount — /auth/me 401 with no session evidence', () => {
  it('does not post /auth/refresh', async () => {
    const fetchMock = vi.fn(async () => res(401, { success: false }));
    globalThis.fetch = fetchMock as never;
    const { api } = await import('@web/lib/api');

    const result = await api.getProfile();

    expect(refreshCalls(fetchMock)).toHaveLength(0);
    // The guest is reported as unauthenticated, NOT as rate-limited: AuthContext
    // must still be able to settle them as a guest.
    expect(result.success).toBe(false);
    expect(result.error?.code).not.toBe('RATE_LIMITED');
  });

  it('does not post /auth/refresh for any other 401 either', async () => {
    const fetchMock = vi.fn(async () => res(401, { success: false }));
    globalThis.fetch = fetchMock as never;
    const { api } = await import('@web/lib/api');

    await api.getCart();

    expect(refreshCalls(fetchMock)).toHaveLength(0);
  });
});

describe('a browser that HAS held a session still recovers (#1789)', () => {
  it('refreshes on the /auth/me 401 once a session marker exists', async () => {
    let meCalls = 0;
    const fetchMock = vi.fn(async (url: unknown) => {
      if (String(url).includes('/auth/refresh')) {
        return res(200, { success: true, data: { refreshed: true, csrfToken: 'c' } });
      }
      meCalls += 1;
      return meCalls === 1
        ? res(401, { success: false })
        : res(200, { success: true, data: { user: { id: 'u1', role: 'customer' } } });
    });
    globalThis.fetch = fetchMock as never;
    const { api } = await import('@web/lib/api');
    localStorage.setItem('hadSession', '1');

    const result = await api.getProfile();

    expect(refreshCalls(fetchMock)).toHaveLength(1);
    expect(result.success).toBe(true);
    expect(meCalls).toBe(2);
  });

  it('a successful /auth/me arms the marker for the next expiry', async () => {
    const fetchMock = vi.fn(async () =>
      res(200, { success: true, data: { user: { id: 'u1', role: 'customer' } } })
    );
    globalThis.fetch = fetchMock as never;
    const { api } = await import('@web/lib/api');

    await api.getProfile();

    expect(localStorage.getItem('hadSession')).toBe('1');
  });

  it('logout disarms it, so the now-anonymous browser stops refreshing', async () => {
    const fetchMock = vi.fn(async () => res(200, { success: true, data: {} }));
    globalThis.fetch = fetchMock as never;
    const { api } = await import('@web/lib/api');
    localStorage.setItem('hadSession', '1');
    localStorage.setItem('csrfToken', 'c');

    await api.logout();

    expect(localStorage.getItem('hadSession')).toBeNull();
    expect(localStorage.getItem('csrfToken')).toBeNull();
  });

  it('a rejected refresh (401) disarms it too — one attempt, not one per page load', async () => {
    const fetchMock = vi.fn(async (url: unknown) =>
      String(url).includes('/auth/refresh')
        ? res(401, { success: false })
        : res(401, { success: false, error: { code: 'UNAUTHORIZED', message: 'no' } })
    );
    globalThis.fetch = fetchMock as never;
    const { api } = await import('@web/lib/api');
    localStorage.setItem('hadSession', '1');

    await api.getProfile();
    expect(refreshCalls(fetchMock)).toHaveLength(1);

    // Second page load: the dead session left no evidence behind.
    await api.getProfile();
    expect(refreshCalls(fetchMock)).toHaveLength(1);
  });
});
